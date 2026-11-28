/**
 * The coding window's words, as constants and pure functions (CLAUDE.md "Writing UI copy": sentence case, British
 * spelling, curly double quotes round names, a single "…" for what is in progress or opens something, no raw errors).
 * The SDK's own names for its modes are kept beside Ember's words for them, as the Copilot app shows them. Pinned in
 * test/unit/code-copy.test.ts.
 */

export const UNREACHABLE = "That didn't reach Ember. Try again.";

// ───── Sidebar ─────
export const SIDEBAR_LABEL = "Projects and sessions";
export const SEARCH_LABEL = "Search sessions";
export const SEARCH_PLACEHOLDER = "Search";
export const NEW_SESSION = "New session…";
export const ADD_PROJECT = "Add project…";
export const CUSTOMISE = "Customise…";
export const LOADING = "Loading sessions…";
export const OTHER_SESSIONS = "Other sessions";
export const ARCHIVED_TITLE = "Archived sessions";
export const BACK_TO_SESSIONS = "Back to sessions";
export function archivedLink(n: number): string { return n ? `Archived (${n.toLocaleString("en-GB")})` : "Archived"; }
export function sidebarEmpty(query: string, archived: boolean): string {
  if (query.trim()) return `No sessions match “${query.trim()}”.`;
  return archived ? "No archived sessions." : "No projects yet. Add a project, then start a session in it.";
}
export const PROJECT_EMPTY = "No sessions yet.";
export function newSessionIn(project: string): string { return `New session in “${project}”`; }
export function foldProject(project: string, folded: boolean): string { return folded ? `Show sessions in “${project}”` : `Hide sessions in “${project}”`; }
/** The project's Remove control, and its question (the folder itself stays as it is). */
export function removeProjectLabel(project: string): string { return `Remove “${project}” from the list…`; }
export function removeProjectQuestion(project: string): string { return `Remove “${project}” from the list? Its folder and files stay as they are.`; }
export const REMOVE_PROJECT = "Remove";
export const KEEP_PROJECT = "Cancel";

/** A session's name: its own, else what it is for. */
export function sessionTitle(row: { name: string }): string { return row.name.trim() || "New session"; }

/** A session's state in words, beside its mark and in its name for a screen reader. */
export function statusWords(status: "needs-you" | "working" | "unread" | "idle"): string {
  if (status === "needs-you") return "Needs you";
  if (status === "working") return "Working";
  if (status === "unread") return "Unread";
  return "";
}
/** A sidebar row's name for a screen reader: the session, where it works and how it stands. */
export function sessionLabel(row: { name: string; isolation: string; branch?: string; pinned: boolean }, status: "needs-you" | "working" | "unread" | "idle"): string {
  const parts = [sessionTitle(row)];
  if (row.isolation === "worktree" && row.branch) parts.push(`worktree ${row.branch}`);
  const words = [row.pinned ? "Pinned" : "", statusWords(status)].filter(Boolean).join(". ");
  return `${parts.join(", ")}${words ? `. ${words}` : ""}`;
}
export function pinLabel(title: string, pinned: boolean): string { return pinned ? `Unpin “${title}”` : `Pin “${title}”`; }
export function archiveLabel(title: string, archived: boolean): string { return archived ? `Restore “${title}”` : `Archive “${title}”`; }
/** When a session last changed, as a list shows it. */
export function updatedWords(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// ───── Modes ─────
/** The SDK's agent modes as the Copilot app names them. */
export function agentModeName(mode: string): string {
  if (mode === "interactive") return "Interactive";
  if (mode === "plan") return "Plan";
  if (mode === "autopilot") return "Autopilot";
  return mode;
}
export function agentModeHint(mode: string): string {
  if (mode === "interactive") return "Copilot works on what you ask, then waits for you.";
  if (mode === "plan") return "Copilot makes a plan with you first, and starts on it when you say so.";
  if (mode === "autopilot") return "Copilot keeps working on its own until the task is done.";
  return "";
}
/** The SDK's permission modes as the Copilot app names them. */
export function permissionModeName(mode: string): string {
  if (mode === "manual") return "Ask every time";
  if (mode === "assisted") return "Assisted";
  if (mode === "allow-all") return "Approve all";
  return mode;
}
export function permissionModeHint(mode: string): string {
  if (mode === "manual") return "Copilot asks before it runs a command, changes a file or fetches an address, unless you allowed that for the session.";
  if (mode === "assisted") return "A second model checks each request against what you asked. What it approves goes ahead; anything else asks you.";
  if (mode === "allow-all") return "Copilot goes ahead without asking. Your organisation's rules still apply, and Stop ends it.";
  return "";
}
/** Reasoning effort levels, as the SDK names them. */
export function effortName(effort: string): string {
  const names: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
  return names[effort] ?? effort;
}
export const DEFAULT_MODEL = "Default model";
export const DEFAULT_EFFORT = "Default";
/** A mode change main or the SDK didn't apply: the one in force, and why where main said. */
export function modeRefused(picker: "agent" | "permission" | "model" | "effort", requested: string, inForce: string | undefined, reason?: string): string {
  const name = picker === "agent" ? agentModeName : picker === "permission" ? permissionModeName : picker === "effort" ? effortName : (m: string) => m;
  const stays = inForce ? `, so “${name(inForce)}” stays in force` : "";
  return `“${name(requested)}” wasn't applied${stays}.${reason ? ` ${reason}` : ""}`;
}

// ───── Start flow ─────
export const START_TITLE = "New session";
export const START_LEAD = "Copilot works in one folder with its own tools. Its modes decide what it may do without asking.";
export const START_PROJECT = "Project";
export const START_CHOOSE_FOLDER = "Choose a folder…";
export const START_NO_PROJECT = "Choose a project or a folder first.";
export const START_WHERE = "Where Copilot works";
export const START_IN_FOLDER = "In the folder itself";
export const START_IN_WORKTREE = "In a new worktree";
export const START_WORKTREE_HINT = "A git worktree of its own, on a new branch, so the folder's own files aren't touched.";
export const START_NO_GIT = "This folder isn't a git repository, so a worktree isn't possible.";
export const START_BASE = "Start from branch";
export function startBaseHint(branch?: string): string { return branch ? `Leave it empty to start from “${branch}”.` : "Leave it empty to start from the folder's current branch."; }
export const START_MODEL = "Model";
export const START_EFFORT = "Reasoning effort";
export const START_AGENT_MODE = "Agent mode";
export const START_PERMISSIONS = "Permissions";
export const START_AGENT = "Agent";
export const START_NO_AGENT = "None";
export const START_NAME = "Name (optional)";
export const START_GO = "Start session";
export const START_CANCEL = "Cancel";
export const STARTING = "Starting…";
export const MODELS_UNAVAILABLE = "The list of models couldn't be read, so the session starts on the default model.";

// ───── Transcript ─────
export const YOU = "You";
export const COPILOT = "Copilot";
export const REASONING = "Reasoning";
export const THINKING = "Thinking…";
export const WORKING = "Working…";
export function intentLine(intent: string): string { return `${intent.replace(/[.…]+$/, "")}…`; }
export function transcriptEmpty(project: string | undefined): string { return project ? `Ask Copilot to do something in “${project}”.` : "Ask Copilot to do something."; }
export const CATCHING_UP = "Catching up…";
export function earlierItems(n: number): string { return `Show ${n.toLocaleString("en-GB")} earlier ${n === 1 ? "item" : "items"}`; }
export function notSent(why: string): string { return `Not sent: ${why}`; }
export const QUEUED_TAG = "Queued";
/** Where a session's commands run, as main says once it has opened the session in this run (`CodeSessionRow.sandbox`). */
export function sandboxWords(sandbox: string | undefined): string {
  if (sandbox === "on") return "In the sandbox";
  if (sandbox === "no-network") return "In the sandbox, without the network";
  if (sandbox === "off") return "Outside the sandbox";
  return "";
}
export const STEERED_TAG = "Sent into the turn";
export function attachedNames(names: readonly string[]): string { return names.length === 1 ? `Attached: ${names[0]}` : `Attached: ${names.join(", ")}`; }
export const CODE_COPY = "Copy";
export const COPIED = "Copied.";
export function codeBlockLabel(lang: string): string { return lang ? `Code, ${lang}` : "Code"; }

/** The last part or two of a path, as a row shows it. */
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : path;
}

/** How a tool row is drawn, by the tool's name (and what it was given). */
export type ToolShape = "shell" | "edit" | "view" | "search" | "fetch" | "mcp" | "agent" | "other";
const SHELL = new Set(["bash", "shell", "powershell", "pwsh", "local_shell", "run_in_terminal", "sh"]);
const EDIT = new Set(["edit", "create", "write", "str_replace_editor", "str_replace", "apply_patch", "write_file", "edit_file"]);
const VIEW = new Set(["view", "read", "read_file", "cat"]);
const SEARCH = new Set(["grep", "glob", "rg", "search", "find", "list_dir", "ls"]);
const FETCH = new Set(["web_fetch", "fetch", "fetch_url", "web_search"]);
export function toolShape(r: { tool: string; mcp?: unknown; command?: string; agent?: unknown; fileEdits?: readonly unknown[] }): ToolShape {
  const t = r.tool.toLowerCase();
  if (r.agent) return "agent";
  if (r.mcp) return "mcp";
  if (SHELL.has(t) || r.command !== undefined) return "shell";
  if (EDIT.has(t)) return "edit";
  if (VIEW.has(t)) return "view";
  if (SEARCH.has(t)) return "search";
  if (FETCH.has(t)) return "fetch";
  if (r.fileEdits?.length) return "edit";
  return "other";
}

const a = (args: Record<string, unknown> | null, ...keys: string[]): string | undefined => {
  for (const k of keys) { const v = args?.[k]; if (typeof v === "string" && v) return v; }
  return undefined;
};

/** A tool row's title, by its shape, what it was given and how far it got. */
export function toolTitle(r: { tool: string; title?: string; args: Record<string, unknown> | null; mcp?: { server: string; tool: string }; command?: string; state: string; fileEdits: readonly { path: string }[]; agent?: { displayName: string } }): string {
  const running = r.state === "running", failed = r.state === "failed";
  const shape = toolShape(r);
  const path = a(r.args, "path", "file_path", "filePath") ?? (r.fileEdits.length === 1 ? r.fileEdits[0].path : undefined);
  switch (shape) {
    case "agent": return `Sub-agent “${r.agent!.displayName}”`;
    case "shell": return running ? "Running a command…" : failed ? "Command failed" : "Ran a command";
    case "edit": {
      const what = path ? pathTail(path) : r.fileEdits.length > 1 ? `${r.fileEdits.length} files` : "a file";
      const create = r.tool.toLowerCase() === "create";
      return running ? `${create ? "Creating" : "Changing"} ${what}…` : failed ? `Couldn't ${create ? "create" : "change"} ${what}` : `${create ? "Created" : "Changed"} ${what}`;
    }
    case "view": {
      const what = path ? pathTail(path) : "a file";
      return running ? `Reading ${what}…` : failed ? `Couldn't read ${what}` : `Read ${what}`;
    }
    case "search": {
      const pattern = a(r.args, "pattern", "query", "glob", "regex");
      const where = a(r.args, "path", "cwd", "directory");
      const what = pattern ? `“${pattern}”` : "files";
      const place = where ? ` in ${pathTail(where)}` : "";
      return running ? `Searching for ${what}${place}…` : failed ? `Search for ${what}${place} failed` : `Searched for ${what}${place}`;
    }
    case "fetch": {
      const what = a(r.args, "url", "query") ?? "a web address";
      const search = r.tool.toLowerCase() === "web_search";
      if (search) return running ? `Searching the web for “${what}”…` : failed ? `Web search for “${what}” failed` : `Searched the web for “${what}”`;
      return running ? `Fetching ${what}…` : failed ? `Couldn't fetch ${what}` : `Fetched ${what}`;
    }
    case "mcp": {
      const { server, tool } = r.mcp!;
      return running ? `Using “${tool}” from “${server}”…` : failed ? `“${tool}” from “${server}” failed` : `Used “${tool}” from “${server}”`;
    }
    default: {
      const name = r.title ?? r.tool;
      return running ? `Using ${name}…` : failed ? `${name} failed` : `Used ${name}`;
    }
  }
}

/** How a tool ended: its exit code where it has one, and whether the sandbox held it. */
export function toolEnd(r: { state: string; exitCode?: number; sandboxed?: boolean }): string {
  if (r.state === "running") return "";
  const end = r.state === "failed" ? "Failed" : "Finished";
  const code = r.exitCode !== undefined ? `, exit code ${r.exitCode}` : "";
  const box = r.sandboxed === true ? " Ran in the sandbox." : r.sandboxed === false ? " Ran outside the sandbox." : "";
  return `${end}${code}.${box}`;
}
export const SANDBOXED_TAG = "Sandboxed";
export const UNSANDBOXED_TAG = "Not sandboxed";
export const TOOL_DETAILS = "Details";
export const TOOL_ARGS = "What it was given";
export const TOOL_OUTPUT = "Output";
export const TOOL_RESULT = "Result";
export const OUTPUT_CUT = "Earlier output isn't shown.";
export function outputLabel(title: string): string { return `Output of ${title}`; }
export function agentState(r: { state: string; error?: string; totalToolCalls?: number; durationMs?: number }): string {
  const steps = r.totalToolCalls !== undefined ? ` ${r.totalToolCalls.toLocaleString("en-GB")} ${r.totalToolCalls === 1 ? "step" : "steps"}` : "";
  const time = r.durationMs !== undefined ? ` in ${Math.max(1, Math.round(r.durationMs / 1000)).toLocaleString("en-GB")} s` : "";
  if (r.state === "running") return "Working…";
  if (r.state === "failed") return `Failed${r.error ? `: ${r.error}` : "."}`;
  if (r.state === "cancelled") return "Cancelled.";
  return `Finished:${steps || " done"}${time}.`;
}
export function agentWork(n: number, open: boolean): string { return `${open ? "Hide" : "Show"} its work (${n.toLocaleString("en-GB")} ${n === 1 ? "item" : "items"})`; }

/** A note's words, by its kind and fields. */
export function noteWords(note: string, f: Readonly<Record<string, string | number | boolean | undefined>>): string {
  switch (note) {
    case "plan": return f.operation === "create" ? "Copilot made a plan." : f.operation === "delete" ? "Copilot removed its plan." : "Copilot changed its plan.";
    case "todos": return "Copilot updated its to-do list.";
    case "compaction":
      if (f.state === "running") return "Making room in the context…";
      if (f.state === "failed") return "Couldn't make room in the context.";
      return typeof f.tokensRemoved === "number" ? `Made room in the context: ${f.tokensRemoved.toLocaleString("en-GB")} tokens fewer.` : "Made room in the context.";
    case "model": return f.from ? `Model changed from ${f.from} to ${f.to}${f.effort ? `, ${effortName(String(f.effort))} reasoning` : ""}.` : `Model: ${f.to}${f.effort ? `, ${effortName(String(f.effort))} reasoning` : ""}.`;
    case "mode": return `Agent mode is now “${agentModeName(String(f.to ?? ""))}”.`;
    case "permissions": return `Permissions are now “${permissionModeName(String(f.to ?? ""))}”.`;
    case "skill": return `Used the skill “${f.name ?? "skill"}”${f.plugin ? ` from “${f.plugin}”` : ""}.`;
    case "agent": return f.on ? `Working as “${f.agent ?? "agent"}”.` : "No longer working as a custom agent.";
    case "abort": return "Stopped.";
    case "notification": return String(f.text ?? "");
    case "info": return `${f.message ?? ""}${f.tip ? ` ${f.tip}` : ""}`;
    default: return "";
  }
}
export function hookWords(h: { hookType: string; state: string; error?: string }): string {
  if (h.state === "running") return `Running the “${h.hookType}” hook…`;
  if (h.state === "failed") return `The “${h.hookType}” hook failed${h.error ? `: ${h.error}` : "."}`;
  return `Ran the “${h.hookType}” hook.`;
}

/** A session's error as a plain sentence (the SDK's own text is folded under it), with the remedy the SDK names. */
export function problemLead(level: "error" | "warning", type?: string): string {
  if (level === "warning") return "Copilot's warning";
  if (type === "rate_limit" || type === "quota") return "Copilot has reached a usage limit for now.";
  if (type === "authentication" || type === "auth") return "Copilot couldn't confirm your GitHub sign-in.";
  return "Copilot ran into a problem and stopped this turn.";
}
export function remedy(remediation: string | undefined): string {
  switch (remediation) {
    case "sign_in": return "Sign in to GitHub again, then try again.";
    case "switch_account": return "Switch to a GitHub account with Copilot, then try again.";
    case "show_account": return "Check your GitHub account's Copilot access.";
    case "review_sandbox_policy": return "Review what the sandbox allows (Customise › Sandbox), then try again.";
    case "allow_sandbox_outbound": return "Let the sandbox reach the internet (Customise › Sandbox), then try again.";
    case "rewind_conversation": return "Go back to an earlier point in the session and try again.";
    default: return "";
  }
}
export const PROBLEM_DETAILS = "Details";
export function eventSummary(type: string): string { return `Event: ${type}`; }

// ───── Request cards ─────
export const NEEDS_YOU = "Needs you";
export const CARD_LEAD = "Copilot asks";
export function permissionTitle(view: { kind: string; tool?: string; server?: string; sdkKind?: string }): string {
  switch (view.kind) {
    case "shell": return "Run a command?";
    case "write": return "Change a file?";
    case "read": return "Read a file?";
    case "url": return "Fetch a web address?";
    case "mcp": return `Use “${view.tool}” from “${view.server}”?`;
    case "memory": return "Remember something?";
    case "custom-tool": return `Use “${view.tool}”?`;
    case "hook": return `Let “${view.tool}” go ahead?`;
    default: return `Allow this ${view.sdkKind ?? "step"}?`;
  }
}
export const FIELDS = {
  command: "Command", reason: "Copilot's reason", file: "File", changes: "Changes", contents: "New file", path: "Path", address: "Address",
  server: "Server", tool: "Tool", args: "Given", fact: "To remember", message: "Its message", paths: "Files it may touch",
  urls: "Addresses it may reach", details: "What it asks", covers: "Commands",
} as const;
/** A decision's button, by the SDK's kind of decision and of request. */
export function decisionLabel(kind: string, request: string): string {
  if (kind === "approve-once") return "Allow once";
  if (kind === "approve-for-session") return request === "url" ? "Allow this site for the session" : "Allow for this session";
  if (kind === "approve-read-only-for-session") return "Allow reading this folder for the session";
  if (kind === "approve-for-location") return "Allow in this folder";
  if (kind === "approve-permanently") return "Always allow this site";
  if (kind === "reject") return "Don't allow";
  if (kind === "user-not-available") return "Not now";
  return kind;
}
export function covers(ids: readonly string[]): string { return `“Allow for this session” covers: ${ids.join(", ")}.`; }
export const WRITES_FILES = "This command writes to a file.";
export const READ_ONLY = "This tool says it only reads.";
export const MANAGED = "Your organisation's rules ask for your decision on this one.";
export function sandboxBypass(reason: string): string { return `Copilot asks to run this outside the sandbox${reason ? `: ${reason}` : "."}`; }
export function warningLine(text: string): string { return `Copilot's warning: ${text}`; }
/** The SDK's assisted check, as its own line on the card. */
export function assistedLine(a: { recommendation: string; reason?: string }): string {
  const lead = a.recommendation === "approve" ? "The assisted check recommends allowing it."
    : a.recommendation === "requireApproval" ? "The assisted check leaves this to you."
      : a.recommendation === "excluded" ? "The assisted check doesn't look at this kind of request."
        : "The assisted check couldn't decide.";
  return a.reason ? `${lead} Its reason: ${a.reason}` : lead;
}
export function riskLine(risk: string): string { return `Copilot's risk assessment: ${risk}`; }
export const REASON_SUMMARY = "Tell Copilot why, if you don't allow it";
export const REASON_LABEL = "Reason for Copilot (optional)";
export const SENDING = "Sending your answer…";
export const NOT_BUILT = "This choice couldn't be made for this request.";

/** Who answered a request, as a record says it. */
export function byWords(by: string | undefined): string {
  if (by === "user") return "by you";
  if (by === "companion") return "by Ember's companion";
  if (by === "system") return "by Ember";
  return "by Copilot";
}
/** A permission's record: what the SDK says was decided, and by whom. */
export function permissionRecord(outcome: unknown, by: string | undefined): string {
  const kind = typeof outcome === "object" && outcome ? String((outcome as { kind?: unknown }).kind ?? "") : typeof outcome === "string" ? outcome : "";
  const who = byWords(by);
  if (kind === "approved-for-session" || kind === "approve-for-session") return `Allowed for this session, ${who}.`;
  if (kind === "approved-for-location" || kind === "approve-for-location") return `Allowed in this folder, ${who}.`;
  if (kind === "approve-permanently" || kind === "approved-permanently") return `Always allowed, ${who}.`;
  // The runtime records a one-time yes as "approved" (no rule kept); the window's own answer is "approve-once".
  if (kind === "approved" || kind === "approve-once") return `Allowed once, ${who}.`;
  if (kind.startsWith("approve")) return `Allowed, ${who}.`;
  if (kind === "cancelled") return "Cancelled before a decision.";
  if (kind === "denied-by-rules") return "Not allowed, by Copilot's rules.";
  if (kind === "denied-by-content-exclusion-policy") return "Not allowed: your organisation's content exclusion covers it.";
  if (kind === "denied-by-permission-request-hook") return "Not allowed, by a hook.";
  if (kind === "user-not-available") return `Left for later, ${who}.`;
  if (kind.startsWith("denied") || kind === "reject") return `Not allowed, ${who}.`;
  return `Answered, ${who}.`;
}
export const QUESTION_LEAD = "Copilot asks you";
export const ANSWER_LABEL = "Your answer";
export const ANSWER_SEND = "Send answer";
export function answeredRecord(answer: string | undefined, by: string | undefined): string { return answer ? `Answered “${answer}”, ${byWords(by)}.` : `Answered, ${byWords(by)}.`; }
export function elicitationLead(source?: string): string { return source ? `“${source}” asks for details` : "Copilot asks for details"; }
export const ELICITATION_SUBMIT = "Send";
export const ELICITATION_DECLINE = "Decline";
export const ELICITATION_CANCEL = "Cancel";
export const ELICITATION_URL = "Open this address in your browser to go on:";
export const ELICITATION_URL_DONE = "I've done it";
export const COPY_ADDRESS = "Copy address";
export const OPEN_ADDRESS = "Open in your browser";
export function fieldProblem(label: string, problem: string): string {
  if (problem === "required") return `“${label}” is needed.`;
  if (problem === "number") return `“${label}” needs a number.`;
  if (problem === "integer") return `“${label}” needs a whole number.`;
  if (problem === "range") return `“${label}” is outside what it allows.`;
  if (problem === "length") return `“${label}” is too short or too long.`;
  return `“${label}” needs one of its choices.`;
}
export function elicitationRecord(outcome: unknown, by: string | undefined): string {
  const action = typeof outcome === "string" ? outcome : typeof outcome === "object" && outcome ? String((outcome as { action?: unknown }).action ?? "") : "";
  if (action === "accept") return `Details sent, ${byWords(by)}.`;
  if (action === "decline") return `Declined, ${byWords(by)}.`;
  if (action === "cancel") return `Cancelled, ${byWords(by)}.`;
  return `Answered, ${byWords(by)}.`;
}
export const PLAN_EXIT_TITLE = "Start on the plan?";
export const PLAN_LABEL = "The plan";
export function planAction(action: string): string {
  if (action === "exit_only") return "Leave plan mode only";
  if (action === "interactive") return "Start, step by step";
  if (action === "autopilot") return "Start on Autopilot";
  if (action === "autopilot_fleet") return "Start on Autopilot with a fleet";
  return action;
}
export const RECOMMENDED = "Recommended";
export const PLAN_KEEP = "Keep planning";
export const PLAN_FEEDBACK = "Feedback for Copilot (optional)";
export function planRecord(outcome: unknown, by: string | undefined): string {
  const o = typeof outcome === "object" && outcome ? outcome as { approved?: unknown; selectedAction?: unknown } : {};
  if (o.approved === true) return `${planAction(String(o.selectedAction ?? "interactive"))}: chosen ${byWords(by)}.`;
  if (o.approved === false) return `Kept planning, ${byWords(by)}.`;
  return `Answered, ${byWords(by)}.`;
}
export const AUTO_TITLE = "Switch to the auto model?";
export function autoLead(c: { errorCode?: string; retryAfterSeconds?: number }): string {
  const wait = c.retryAfterSeconds !== undefined ? ` The current model can be used again in about ${Math.ceil(c.retryAfterSeconds / 60).toLocaleString("en-GB")} min.` : "";
  return `The current model isn't available for now${c.errorCode ? ` (${c.errorCode})` : ""}.${wait}`;
}
export const AUTO_ANSWERS: Readonly<Record<string, string>> = { yes: "Switch", yes_always: "Always switch", no: "Don't switch" };
export function autoRecord(outcome: unknown, by: string | undefined): string {
  return `${outcome === "no" ? "Didn't switch" : outcome === "yes_always" ? "Switched, and always will" : outcome === "yes" ? "Switched" : "Answered"}, ${byWords(by)}.`;
}
export const LIMITS_TITLE = "This session has used its AI credits";
export function limitsLead(used: number, max: number): string { return `It has used ${used.toLocaleString("en-GB")} of its ${max.toLocaleString("en-GB")} credits.`; }
export const LIMITS_AMOUNT = "Credits to add";
export const LIMITS_ADD = "Add credits";
export const LIMITS_UNSET = "Remove the limit";
export const LIMITS_CANCEL = "Stop here";
export const LIMITS_AMOUNT_NEEDED = "Enter how many credits to add.";
export function limitsRecord(outcome: unknown, by: string | undefined): string {
  const action = typeof outcome === "object" && outcome ? String((outcome as { action?: unknown }).action ?? "") : "";
  const what = action === "add" || action === "set" ? "Credits added" : action === "unset" ? "Limit removed" : action === "cancel" ? "Stopped at the limit" : "Answered";
  return `${what}, ${byWords(by)}.`;
}
export function oauthTitle(server: string): string { return `Sign in to “${server}”?`; }
export function oauthLead(url: string, reason?: string): string {
  const why = reason === "refresh" || reason === "reauth" ? "Its sign-in has run out." : reason === "upscope" ? "It needs more access." : "It needs you to sign in.";
  return `${why} Its address: ${url}`;
}
export const OAUTH_NOTE = "Signing in from here isn't offered yet.";
export const OAUTH_NOT_NOW = "Not now";
export function samplingTitle(server: string): string { return `“${server}” asks to use the model`; }
export const SAMPLING_NOTE = "Allowing this isn't offered yet.";
export const SAMPLING_REFUSE = "Don't allow";
export function genericRecord(by: string | undefined): string { return `Answered, ${byWords(by)}.`; }
export function needsYouBar(n: number): string { return n === 1 ? "Copilot is waiting for you" : `Copilot is waiting for you: ${n.toLocaleString("en-GB")} requests`; }
export const GO_TO_REQUEST = "Go to request";
export function asksSaid(title: string, session: string): string { return `Copilot asks in “${session}”: ${title}`; }
export function replySaid(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `Copilot replied: ${t.length > 300 ? `${t.slice(0, 300)}…` : t}`;
}

// ───── Composer ─────
export const MESSAGE_LABEL = "Message Copilot";
export const MESSAGE_PLACEHOLDER = "Ask Copilot to do something. Type @ for files and / for commands.";
export const SEND = "Send";
export const QUEUE = "Queue";
export const STEER = "Steer now";
export const STOP = "Stop";
export function stopLabel(title: string): string { return `Stop: ${title}`; }
export const ATTACH = "Attach files…";
export const SEND_HINT = "Enter sends. Shift+Enter adds a line.";
export const BUSY_HINT = "Enter queues your message for after this turn. Steer now sends it into the turn.";
export function removeAttachment(name: string): string { return `Remove “${name}”`; }
export function tooLong(n: number, limit: number): string { return `${(n - limit).toLocaleString("en-GB")} characters over the limit of ${limit.toLocaleString("en-GB")}. Shorten it to send.`; }
export function blobTooBig(limitBytes: number): string { return `That image is larger than ${Math.round(limitBytes / 1024 / 1024)} MB, so it wasn't attached.`; }
export function tooManyAttachments(limit: number): string { return `A message takes at most ${limit} attachments.`; }
export const DROP_ONLY_IMAGES = "Only images can be dropped here. Use Attach files… for other files.";
export const PASTED_IMAGE = "Pasted image";
export const PICK_MODEL = "Model";
export const PICK_EFFORT = "Reasoning";
export const PICK_AGENT_MODE = "Agent mode";
export const PICK_PERMISSIONS = "Permissions";
export function usageWords(current: number, limit: number): string {
  const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
  return `${pct}% of the context used (${current.toLocaleString("en-GB")} of ${limit.toLocaleString("en-GB")} tokens)`;
}
export function usageShort(current: number, limit: number): string { return `${limit > 0 ? Math.round((current / limit) * 100) : 0}% context`; }
export function lastCallWords(c: { inputTokens?: number; outputTokens?: number }): string {
  if (c.inputTokens === undefined && c.outputTokens === undefined) return "";
  return `Last reply: ${(c.inputTokens ?? 0).toLocaleString("en-GB")} tokens in, ${(c.outputTokens ?? 0).toLocaleString("en-GB")} out`;
}
export const CONTEXT_LABEL = "Context used";
export function queueTitle(n: number): string { return `Queued (${n.toLocaleString("en-GB")})`; }
export const QUEUE_EDIT = "Edit";
export const QUEUE_REMOVE = "Remove";
export const QUEUE_SEND_NOW = "Send now";
export const QUEUE_SAVE = "Save";
export const QUEUE_CANCEL = "Cancel";
export function queueItemLabel(what: string, text: string): string { return `${what}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`; }
export function steeringLine(text: string): string { return `Steering: ${text}`; }
export const SUGGESTIONS = "Suggestions";

// ───── Panel and its tabs ─────
export const PANEL_LABEL = "Session panel";
export const PANEL_SHOW = "Show panel";
export const PANEL_HIDE = "Hide panel";
export const PANEL_RESIZE = "Resize the panel";
export const SIDEBAR_RESIZE = "Resize the sidebar";
export const PANEL_NO_SESSION = "Open a session to see its details here.";
export const TAB_NAMES: Readonly<Record<string, string>> = { changes: "Changes", plan: "Plan", files: "Files", terminal: "Terminal", agents: "Agents and tasks" };
export const TAB_EMPTY: Readonly<Record<string, string>> = {
  changes: "The session's changes will show here, file by file.",
  plan: "Copilot's plan and its to-do list will show here.",
  files: "The session's files will show here.",
  terminal: "A terminal in the session's folder will show here.",
  agents: "Background agents and shells will show here.",
};

// ───── Customise ─────
export const CUSTOMISE_TITLE = "Customise";
export const CUSTOMISE_DONE = "Done";
export const CUSTOMISE_SECTIONS = ["Models", "MCP servers", "Skills", "Plugins", "Agents", "Instructions", "Hooks", "Permissions", "Sandbox", "Schedules", "Usage"] as const;
export function customiseEmpty(section: string): string { return `${section} will show here.`; }

// ───── Command palette ─────
export const PALETTE_TITLE = "Commands";
export const PALETTE_PLACEHOLDER = "Type a command";
export const PALETTE_EMPTY = "Nothing found";
export const PALETTE_ACTIONS = {
  newSession: "New session…", addProject: "Add project…", search: "Search sessions", archived: "Show archived sessions", sessions: "Show sessions",
  panel: "Show or hide the panel", customise: "Customise…", stop: "Stop the turn", stopAll: "Stop everything", attach: "Attach files…", focusComposer: "Go to the message box",
  fork: "Fork this session", remove: "Delete this session…", keep: "Keep the session",
} as const;
/** The palette's second step for Delete: what goes with it, said before it goes. */
export function removeSessionAction(title: string, worktree: boolean): string {
  return worktree ? `Delete “${title}”, its history and its worktree` : `Delete “${title}” and its history`;
}
export function paletteTab(name: string): string { return `Show ${name}`; }
export function paletteSlash(name: string): string { return `Run /${name}`; }
export function paletteHint(chord: string): string { return `${chord} opens commands`; }
