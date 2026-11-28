/**
 * Customise's words (docs/CODING-APP.md §4 "Customise"): every line its sections show, as constants and pure functions,
 * so test/unit/code-customise-copy.test.ts pins them. Sentence case, British spelling, curly double quotes round
 * names, straight apostrophes and "…" on what opens something. Names from the SDK (a server's, a skill's, a model's)
 * are only ever quoted, never read as Ember's words; an SDK failure is said in main's sentence or one of these, never
 * the SDK's own text.
 */
import { effortName } from "./copy";
import { byteSize, everyWords, multiplierWords, tokenCount, whenWords, wordsOf, type McpStatus, type ModelRow, type PolicyState, type QuotaRow } from "./customise-read";

// ───── Every section ─────
export const SCOPE_COMPUTER = "Applies to this computer: every session here uses it.";
export function scopeSession(name: string): string { return `Applies to the session “${name}”.`; }
export function scopeBoth(name: string): string { return `Parts of this apply to this computer, and parts to the session “${name}”.`; }
export const SCOPE_BOTH_NONE = "Parts of this apply to this computer, and parts to a session: open one to see its part.";
export const NO_SESSION = "Open a session to see this. It is the session's own.";
export const SESSION_PART_NONE = "Open a session to see this part.";
export const NO_SESSIONS = "There are no sessions yet. Start one, then come back here.";
export const CHOOSE_SESSION = "Session";
export const PART_COMPUTER = "On this computer";
export function partSession(name: string): string { return `In “${name}”`; }
export const LOADING = "Loading…";
export const NOT_AVAILABLE = "This isn't available in the coding window yet.";
export const FAILED = "Copilot couldn't answer that.";
export const RETRY = "Try again";
export const RELOAD = "Reload";
export const CANCEL = "Cancel";
export function sourceWords(source: string): string {
  const names: Record<string, string> = {
    user: "Yours", workspace: "This folder's", project: "This project's", repository: "This repository's", "working-directory": "This folder's",
    plugin: "From a plugin", builtin: "Built in", managed: "Your organisation's", account: "Your account's", inherited: "From a parent folder",
    "personal-copilot": "Yours", "personal-agents": "Yours", custom: "Yours", sdk: "Ember's", remote: "Remote", policy: "Your organisation's",
    home: "Yours", repo: "This repository's", model: "The model's", vscode: "VS Code's", "nested-agents": "A folder's", "child-instructions": "A folder's",
  };
  return names[source] ?? (source ? wordsOf(source) : "");
}
export function fromPlugin(name: string): string { return `From the plugin “${name}”`; }
export function removeQuestion(name: string): string { return `Remove “${name}”?`; }
export const REMOVE = "Remove";
export const EDIT = "Edit…";
export function turnedOn(name: string, on: boolean): string { return on ? `“${name}” is on.` : `“${name}” is off.`; }
export function removed(name: string): string { return `“${name}” was removed.`; }
export const RELOADED = "Read again.";
export function loadedWith(d: { warnings: number; errors: number }): string {
  if (!d.warnings && !d.errors) return "Read again.";
  const parts = [d.errors ? `${d.errors} couldn't be read` : "", d.warnings ? `${d.warnings} ${d.warnings === 1 ? "has a warning" : "have warnings"}` : ""].filter(Boolean);
  return `Read again: ${parts.join(", ")}.`;
}
export const WHERE_FILES_GO = "Where files go";
export const PREFERRED = "Used for new ones";

// ───── Models ─────
export const MODELS_AVAILABLE = "Models you can use";
export const MODELS_NONE = "Copilot lists no models for this account.";
export const MODELS_SESSION = "The session's model";
export const MODEL_LABEL = "Model";
export const EFFORT_LABEL = "Reasoning effort";
export const EFFORT_NONE = "This model has no reasoning effort to choose.";
export const MODEL_SWITCH = "Switch model";
export const EFFORT_SET = "Set effort";
export function modelSwitched(name: string, deferred: boolean): string { return deferred ? `“${name}” takes over when this turn ends.` : `The session now uses “${name}”.`; }
export function effortChanged(effort: string): string { return `Reasoning effort is now “${effortName(effort)}”.`; }
export function modelMeta(m: ModelRow): string {
  return [
    m.vendor,
    m.context ? `${tokenCount(m.context)} tokens of context` : "",
    m.vision ? "Reads images" : "",
    m.efforts.length ? `Reasoning: ${m.efforts.map(effortName).join(", ")}` : "",
    m.multiplier !== undefined ? multiplierCost(m.multiplier) : "",
  ].filter(Boolean).join(" · ");
}
export function multiplierCost(m: number): string { return m === 0 ? "Included in your plan" : `${multiplierWords(m)} premium requests`; }
export function policyWords(p: PolicyState | undefined): string {
  if (p === "disabled") return "Turned off by your organisation";
  if (p === "unconfigured") return "Not turned on for your account yet";
  return "";
}
export const PROVIDERS = "Other model providers";
export const PROVIDERS_LEAD = "Providers Copilot can find, such as a model server on this computer. They're shown as they stand. To use your own provider with a key, set it in Ember's settings, under Models & connections › Model provider.";
export const PROVIDERS_NONE = "Copilot knows no other providers here.";
export const PROVIDERS_FIND = "Look for providers";
export function providerReach(network: string | undefined): string {
  const words: Record<string, string> = { none: "Looks on this computer only", loopbackOnly: "Looks on this computer only", configuredEndpointOnly: "Looks only where it's set up to", localNetwork: "Looks on your local network", internet: "Looks on the internet" };
  return network ? words[network] ?? "" : "";
}
export const PROVIDER_NEEDS_INPUT = "Needs details to look for it, which the coding window doesn't take.";
export const PROVIDER_NEEDS_TRUST = "Needs to be turned on by a trusted extension first.";
export function providerOutcome(code: string): string {
  if (code === "absent") return "None found.";
  if (code === "unreachable") return "It couldn't be reached.";
  if (code === "success") return "";
  return "Copilot couldn't look for it.";
}
export function providerState(status: string, version?: string): string {
  const words: Record<string, string> = { healthy: "Running", unreachable: "Can't be reached", notInstalled: "Not installed" };
  return `${words[status] ?? wordsOf(status)}${version ? `, version ${version}` : ""}`;
}
export function providerModelLine(m: { name: string; size?: number }): string { return m.size !== undefined ? `${m.name} · ${byteSize(m.size)}` : m.name; }

// ───── MCP servers ─────
export const MCP_CONFIGURED = "Servers";
export const MCP_NONE = "No servers are set up yet.";
export const MCP_ADD = "Add server…";
export const MCP_RELOAD = "Read the settings again";
export const MCP_LIVE = "In this session";
export const MCP_LIVE_NONE = "This session has no servers.";
export const MCP_ALSO = "Also found";
export const MCP_ALSO_LEAD = "Servers from plugins, this folder and your organisation. Turn them on or off above when they're yours, or in their plugin.";
export function mcpStatusWords(s: McpStatus, failed = false): string {
  const words: Record<McpStatus, string> = {
    connected: "Connected", failed: "Couldn't connect", "needs-auth": "Needs you to sign in", pending: "Connecting…", disabled: "Turned off",
    stopped: "Stopped", not_configured: "Not set up", unknown: "Not known",
  };
  return s === "connected" && failed ? "Connected, with a problem" : words[s];
}
export function mcpKind(kind: string): string { return kind === "stdio" ? "Runs on this computer" : kind === "sse" ? "Remote (SSE)" : "Remote (HTTP)"; }
export function envNamesLine(names: readonly string[]): string { return names.length ? `Variables: ${names.join(", ")}` : ""; }
export function headerNamesLine(names: readonly string[]): string { return names.length ? `Headers: ${names.join(", ")}` : ""; }
export const MCP_TOOLS = "Tools";
export const MCP_RESOURCES = "Resources";
export const MCP_PROMPTS = "Prompts";
export function mcpDetails(name: string): string { return `What “${name}” offers`; }
export function mcpItemsNone(kind: "tools" | "resources" | "prompts"): string { return kind === "tools" ? "No tools." : kind === "resources" ? "No resources." : "No prompts."; }
export const MCP_START = "Start";
export const MCP_STOP = "Stop";
export const MCP_RESTART = "Restart";
export const MCP_SIGN_IN = "Sign in…";
export function mcpStartLabel(verb: string, name: string): string { return `${verb} “${name}”`; }
export function mcpStarted(name: string, verb: "start" | "stop" | "restart"): string { return verb === "stop" ? `“${name}” was stopped.` : verb === "restart" ? `“${name}” is restarting.` : `“${name}” is starting.`; }
export const SIGNED_IN = "Signed in. The server is connecting again.";
export const SIGN_IN_LINK = "Open this address in your browser to sign in, then come back here:";
export const SIGN_IN_COPY = "Copy address";
export const SIGN_IN_COPIED = "Address copied.";
export const SIGN_IN_UNUSABLE = "The server gave a sign-in address Ember won't use, as it isn't a secure one.";
export const SIGN_IN_WINDOW = "The coding window can't open your browser yet, so copy the address.";
export const MCP_FIND = "Finding servers in a catalogue isn't in the coding window yet. Add one by its command or address.";
export const MCP_EVENTS_NOTE = "Status changes show while the session is open in this window.";
// The form.
export function mcpFormTitle(editing: string | null): string { return editing ? `Edit “${editing}”` : "Add a server"; }
export const F_NAME = "Name";
export const F_NAME_HINT = "Letters, digits, “-”, “_” and “.”. Copilot names its tools after it.";
export const F_KIND = "Kind";
export const F_KIND_STDIO = "A program on this computer";
export const F_KIND_HTTP = "A remote server (HTTP)";
export const F_KIND_SSE = "A remote server (SSE)";
export const F_COMMAND = "Command";
export const F_COMMAND_HINT = "The program to run, such as “npx” or a full path.";
export const F_ARGS = "Arguments";
export const F_ARGS_HINT = "One on each line.";
export const F_CWD = "Working folder (optional)";
export const F_ENV = "Environment variables";
export const F_ENV_HINT = "Values are kept by Copilot and never shown again. Leave a value empty to keep the one it has.";
export const F_URL = "Address";
export const F_URL_HINT = "An https:// address, or http:// on this computer.";
export const F_HEADERS = "Headers";
export const F_HEADERS_HINT = "Values are kept by Copilot and never shown again. Leave a value empty to keep the one it has.";
export function fieldLabel(kind: "env" | "header", part: "name" | "value", n: number): string { return `${kind === "env" ? "Variable" : "Header"} ${n} ${part}`; }
export const F_ADD_ENV = "Add a variable";
export const F_ADD_HEADER = "Add a header";
export function removeField(kind: "env" | "header", n: number): string { return `Remove ${kind === "env" ? "variable" : "header"} ${n}`; }
export const F_SAVE = "Save";
export const F_ADDED = (name: string) => `“${name}” was added. New sessions start it.`;
export const F_SAVED = (name: string) => `“${name}” was saved. Restart it in a session to use the change.`;
export const F_KEPT = "Kept";
export const E_NAME_EMPTY = "Give the server a name.";
export const E_NAME_CHARS = "Use only letters, digits, “-”, “_” and “.”, up to 64 of them.";
export const E_NAME_TAKEN = "There's a server with this name already.";
export const E_COMMAND = "Say which program to run.";
export const E_ONE_LINE = "Put this on one line.";
export const E_URL = "Give a whole address, starting https://.";
export const E_URL_PLAIN = "Use https://, or http:// only for this computer.";
export const E_VAR_NAME = "Use letters, digits and “_”, not starting with a digit.";
export const E_HEADER_NAME = "Use letters, digits and “-”, with no spaces.";
export const E_DUPLICATE = "This name is here twice.";
export const E_VALUE_NEEDED = "Give it a value.";
export const E_FOLDER = "Give a whole path, such as /home/you/project.";
export const E_FORM = "Some fields need changing first.";

// ───── Skills ─────
export const SKILLS_SESSION = "Skills in this session";
export const SKILLS_COMPUTER = "Skills for new sessions";
export const SKILLS_NONE = "No skills found.";
export function skillCommand(c: string, hint?: string): string { return `Use it as /${c}${hint ? ` ${hint}` : ""}`; }
export const SKILLS_INSTALL = "Installing a skill from a catalogue isn't in the coding window yet. Put a skill's folder, with its SKILL.md, in one of the places below, then reload.";
export const SKILLS_SESSION_HINT = "Turning one off here lasts for this session only.";
export const SKILLS_COMPUTER_HINT = "Turning one off here keeps it off in every new session.";

// ───── Plugins ─────
export const PLUGINS_INSTALLED = "Installed plugins";
export const PLUGINS_NONE = "No plugins are installed.";
export const PLUGINS_HINT = "A plugin can bring skills, agents, hooks and servers. Changes apply to new sessions.";
export const PLUGIN_INSTALL = "Install";
export const PLUGIN_INSTALL_LABEL = "Install a plugin";
export const PLUGIN_INSTALL_HINT = "A plugin from a marketplace as name@marketplace, or a repository as owner/repo.";
export const PLUGIN_UPDATE = "Update";
export const PLUGIN_UPDATE_ALL = "Update all";
export const PLUGIN_UNINSTALL = "Uninstall";
export function uninstallQuestion(name: string): string { return `Uninstall “${name}”? Its skills, agents and servers go with it.`; }
export function pluginMeta(p: { marketplace: string; version?: string; managed: boolean; builtin: boolean }): string {
  return [p.builtin ? "Built in" : p.marketplace ? `From “${p.marketplace}”` : "Installed directly", p.version ? `version ${p.version}` : "", p.managed ? "Managed by your organisation" : ""].filter(Boolean).join(" · ");
}
export function pluginInstalledWords(name: string, skills: number, deprecated: boolean): string {
  return `“${name}” was installed${skills ? `, with ${skills} ${skills === 1 ? "skill" : "skills"}` : ""}.${deprecated ? " Installing straight from a repository will stop working: use a marketplace where you can." : ""}`;
}
export function pluginUpdatedWords(name: string, u: { from?: string; to?: string }): string {
  return u.to && u.from && u.to !== u.from ? `“${name}” went from version ${u.from} to ${u.to}.` : u.to ? `“${name}” is at version ${u.to}.` : `“${name}” was updated.`;
}
export const UPDATED_ALL = "Every plugin was updated.";
export function uninstalled(name: string): string { return `“${name}” was uninstalled.`; }
export const MARKETPLACES = "Marketplaces";
export const MARKETPLACES_NONE = "No marketplaces are added.";
export const MARKET_ADD = "Add";
export const MARKET_ADD_LABEL = "Add a marketplace";
export const MARKET_ADD_HINT = "A GitHub repository as owner/repo, or a git address.";
export function browseLabel(name: string): string { return `Plugins in “${name}”`; }
export const MARKET_REFRESH = "Refresh all";
export const MARKET_DEFAULT = "Comes with Copilot";
export function marketAdded(name: string): string { return `“${name}” was added.`; }
export function marketHeld(name: string, dependents: readonly string[]): string { return `“${name}” wasn't removed: ${dependents.map(d => `“${d}”`).join(", ")} ${dependents.length === 1 ? "comes" : "come"} from it. Uninstall ${dependents.length === 1 ? "it" : "them"} first.`; }
export function refreshedWords(failed: readonly string[]): string { return failed.length ? `Refreshed, but ${failed.map(f => `“${f}”`).join(", ")} couldn't be read.` : "Every marketplace was refreshed."; }
export function installLabel(name: string): string { return `Install “${name}”`; }
export const BROWSE_NONE = "This marketplace offers no plugins.";
export const E_PLUGIN_SPEC = "Give it as name@marketplace, owner/repo or an address.";
export const E_MARKET_SOURCE = "Give it as owner/repo, or a whole git address.";

// ───── Agents ─────
export const AGENTS_SESSION = "Agents in this session";
export const AGENTS_FOUND = "Agents for new sessions";
export const AGENTS_NONE = "No agents found.";
export const IN_USE = "In use";
export const AGENT_USE = "Use";
export const AGENT_STOP_USING = "Use Copilot's own agent";
export function agentUseLabel(name: string): string { return `Use “${name}” in this session`; }
export function agentInUse(name: string | null): string { return name ? `The session uses “${name}”.` : "The session uses Copilot's own agent."; }
export function agentMeta(a: { source: string; model?: string; tools?: readonly string[] }): string {
  return [sourceWords(a.source), a.model ? `Prefers “${a.model}”` : "", a.tools ? (a.tools.length ? `Tools: ${a.tools.join(", ")}` : "No tools") : "All of Copilot's tools"].filter(Boolean).join(" · ");
}
export const AGENT_SUB_ONLY = "Only Copilot starts this one, for part of a task.";
export const AGENTS_HOW = "To make your own agent, put a file named like reviewer.agent.md in one of the places below: a description at its top, then what the agent does. Reload to see it.";

// ───── Instructions ─────
export const INSTRUCTIONS_SESSION = "In force in this session";
export const INSTRUCTIONS_FOUND = "Found for new sessions";
export const INSTRUCTIONS_NONE = "No instruction files found.";
export function appliesTo(globs: readonly string[]): string { return globs.length ? `Only for ${globs.join(", ")}` : "For every file"; }
export const STARTS_OFF = "Off until turned on";
export const IN_FORCE = "In force";
export const NOT_IN_FORCE = "Not in this session";
export const SHOW_TEXT = "Show its text";
export const INSTRUCTIONS_HOW = "Instructions are files Copilot reads before it starts, such as .github/copilot-instructions.md or AGENTS.md in a repository. Put one in a place below, then reload.";

// ───── Hooks ─────
export const HOOKS_FOUND = "Hooks";
export const HOOKS_NONE = "No hooks found.";
export const HOOKS_LEAD = "Hooks run commands when something happens in a session. This list is to read: change a hook in its own file.";
export const HOOKS_REPO = "A repository's own hooks (.github/hooks) run only in a sandboxed session, in a folder you trust (Permissions › Trusted folders). Elsewhere they don't run.";
export function hookEvent(event: string): string {
  const names: Record<string, string> = {
    preToolUse: "Before a tool runs", preMcpToolCall: "Before a server's tool runs", postToolUse: "After a tool runs", postToolUseFailure: "After a tool fails",
    userPromptSubmitted: "When you send a message", userPromptTransformed: "When a message is rewritten", sessionStart: "When a session starts", sessionEnd: "When a session ends",
    postResult: "After a result", prePRDescription: "Before a pull request's description", errorOccurred: "When something goes wrong", agentStop: "When Copilot stops",
    subagentStart: "When a sub-agent starts", subagentStop: "When a sub-agent stops", preCompact: "Before compacting", permissionRequest: "When Copilot asks you", notification: "On a notification",
  };
  return names[event] ?? wordsOf(event);
}
export function hookProblems(d: { warnings: number; errors: number }): string {
  if (!d.warnings && !d.errors) return "";
  return `${d.errors ? `${d.errors} couldn't be read` : ""}${d.errors && d.warnings ? ", " : ""}${d.warnings ? `${d.warnings} ${d.warnings === 1 ? "has a warning" : "have warnings"}` : ""}.`.replace(/^./, c => c.toUpperCase());
}
export const HOOK_OFF = "Turned off";

// ───── Permissions ─────
export const PERM_MODES = "Modes";
export const PERM_MODE_LABEL = "Permissions";
export const AGENT_MODE_LABEL = "Agent mode";
export function modeOffByOrg(name: string): string { return `${name} (turned off by your organisation)`; }
export const PERM_ORG = "Your organisation";
export const ORG_NONE = "Your organisation sets nothing for these sessions.";
export const ORG_APPROVE_ALL_OFF = "Your organisation turned off “Approve all”: Copilot asks or uses Assisted.";
export function orgManages(keys: readonly string[]): string { return `Your organisation manages: ${keys.join(", ")}.`; }
export const ORG_FAIL_CLOSED = "Your organisation's rules couldn't be read, so Copilot keeps to its safest settings.";
export const ORG_DEVICE = "This computer has managed settings.";
export const ORG_DEVICE_UNREADABLE = "This computer's managed settings couldn't be read.";
export const PERM_RULES = "Rules";
export const PERM_RULES_LEAD = "A rule lets Copilot use a tool without asking. Write a tool's kind, and what it may be given in brackets.";
export const RULE_EXAMPLES = "For example: Shell(npm test), Shell(git status), write, read.";
export const RULE_LABEL = "Rule";
export const RULE_SCOPE = "Applies to";
export const RULE_SCOPE_SESSION = "This session";
export const RULE_SCOPE_LOCATION = "This folder, in every session";
export const RULE_ADD = "Add rule";
export const RULE_ADDED = (r: string) => `“${r}” was added.`;
export const RULE_REMOVED = (r: string) => `“${r}” was removed.`;
export const RULES_NONE = "No rules added from this window yet.";
export const RULES_UNLISTED = "Copilot can't list the rules already in force, so this shows the ones added here.";
export const E_RULE_EMPTY = "Write a rule first.";
export const E_RULE_SHAPE = "Write it as a kind, such as write, or a kind with brackets, such as Shell(npm test).";
export const FORGET_APPROVALS = "Forget this session's approvals";
export const FORGET_QUESTION = "Forget every “for this session” approval? Copilot asks again next time.";
export const FORGET = "Forget";
export const FORGOTTEN = "Copilot will ask again.";
export const PERM_FOLDERS = "Allowed folders";
export const PERM_FOLDERS_LEAD = "Copilot's tools may read and change files in these folders.";
export const PRIMARY_FOLDER = "The session's folder";
export const FOLDER_ADD = "Allow folder";
export const FOLDER_LABEL = "Folder to allow";
export const FOLDER_ADDED = (f: string) => `Copilot may now work in “${f}”.`;
export const APPROVED_PATHS = "Approved for this session";
export const PERM_TRUST = "Trusted folders";
export const TRUST_LEAD = "Trusting a folder lets its own hooks run, in the sandbox only. Trust only a repository you know.";
export const TRUSTED = "Trusted";
export const NOT_TRUSTED = "Not trusted";
export function trustLabel(f: string): string { return `Trust “${f}”`; }
export function trustQuestion(f: string): string { return `Trust “${f}”? Its own hooks may then run commands in the sandbox.`; }
export const TRUST = "Trust";
export const TRUST_DONE = (f: string) => `“${f}” is trusted.`;

// ───── Sandbox ─────
export const SANDBOX_HOST = "This computer";
export const SANDBOX_YES = "This computer can run Copilot's tools in a sandbox.";
export const SANDBOX_NO = "This computer has no sandbox, so Copilot's tools run without one.";
export const SANDBOX_CAPS_NONE = "Copilot lists nothing more about it.";
export function capabilityLine(c: { name: string; supported: boolean }): string { return `${capabilityName(c.name)}: ${c.supported ? "yes" : "no"}`; }
export function capabilityName(name: string): string {
  const names: Record<string, string> = { network: "Network inside the sandbox", networkAccess: "Network inside the sandbox", outboundNetwork: "Network inside the sandbox", proxy: "Network through a proxy", credentialProxy: "Signed-in network calls through a proxy", seccomp: "Blocking risky system calls" };
  return names[name] ?? wordsOf(name);
}
export const WHAT_IS_MISSING = "What it needs";
export const SANDBOX_SESSION = "The session";
export function sandboxRow(row: string | undefined): string {
  if (row === "on") return "Its tools run in the sandbox, with the network.";
  if (row === "no-network") return "Its tools run in the sandbox, but without the network: this computer's sandbox can't give it one.";
  if (row === "off") return "Its tools run without a sandbox, because this computer has none.";
  return "Ember tells once the session has opened in this run.";
}
export const ENFORCE_REQUIRED = "Your organisation requires the sandbox.";
export const ENFORCE_BLOCKED = "The sandbox couldn't be kept, so the session was stopped for good. Start a new one.";
export const SANDBOX_WHERE = "The window can't change the sandbox. Ember turns it on wherever this computer has one; your organisation's policy can require it.";

// ───── Schedules ─────
export const SCHEDULES = "Scheduled prompts";
export const SCHEDULES_NONE = "Nothing is scheduled in this session.";
export const SCHEDULES_HOW = "To schedule a prompt, send /every with a time and the prompt (such as /every 30m check the build), or /after to send it once later.";
export function scheduleWhen(r: { recurring: boolean; every?: number; cron?: string; tz?: string; at?: number; next?: string; selfPaced: boolean }): string {
  const how = r.selfPaced ? "When Copilot decides" : r.every ? everyWords(r.every).replace(/^./, c => c.toUpperCase()) : r.cron ? `On the schedule ${r.cron}${r.tz ? ` (${r.tz})` : ""}` : r.at !== undefined ? `Once, ${whenWords(r.at)}` : r.recurring ? "Again and again" : "Once";
  const next = r.next ? whenWords(r.next) : "";
  return next ? `${how} · next ${next}` : how;
}
export const SCHEDULE_STOP = "Stop";
export function scheduleStopLabel(prompt: string): string { return `Stop “${prompt}”`; }
export function scheduleStopQuestion(prompt: string): string { return `Stop sending “${prompt}”?`; }
export const SCHEDULE_STOPPED = "It won't be sent again.";

// ───── Usage ─────
export const USAGE_SESSION = "This session";
export function usageLine(u: { requests: number; premium: number; apiMs: number }): string {
  const mins = Math.round(u.apiMs / 60_000);
  return `${u.requests.toLocaleString("en-GB")} ${u.requests === 1 ? "request" : "requests"} · ${trimNumber(u.premium)} premium ${u.premium === 1 ? "request" : "requests"} used · ${mins < 1 ? "under a minute" : `${mins.toLocaleString("en-GB")} ${mins === 1 ? "minute" : "minutes"}`} with the model`;
}
export function changesLine(u: { linesAdded: number; linesRemoved: number; files: number }): string {
  return `${u.files.toLocaleString("en-GB")} ${u.files === 1 ? "file" : "files"} changed: ${u.linesAdded.toLocaleString("en-GB")} lines added, ${u.linesRemoved.toLocaleString("en-GB")} removed`;
}
export function modelUsageLine(m: { requests: number; input: number; output: number; cached: number }): string {
  return `${m.requests.toLocaleString("en-GB")} ${m.requests === 1 ? "request" : "requests"} · ${tokenCount(m.input)} in, ${tokenCount(m.output)} out${m.cached ? ` · ${tokenCount(m.cached)} from the cache` : ""}`;
}
const trimNumber = (n: number) => String(Number(n.toFixed(2)));
export const QUOTA = "Your allowance";
export const QUOTA_REFRESH = "Check again";
export const QUOTA_NONE = "Copilot reports no allowance for this account.";
export function quotaName(type: string): string {
  const names: Record<string, string> = { chat: "Chat", completions: "Code completions", premium_interactions: "Premium requests", premium_requests: "Premium requests" };
  return names[type] ?? wordsOf(type);
}
export function quotaLine(q: QuotaRow): string {
  if (q.unlimited) return "Unlimited";
  const reset = q.resets !== undefined ? whenWords(q.resets) : "";
  return `${q.used.toLocaleString("en-GB")} of ${q.entitled.toLocaleString("en-GB")} used · ${q.remaining}% left${q.overage ? ` · ${q.overage.toLocaleString("en-GB")} over` : ""}${reset ? ` · starts again ${reset}` : ""}`;
}
export function planWords(plan: string): string {
  const names: Record<string, string> = { free: "Copilot Free", edu: "Copilot for education", pro: "Copilot Pro", pro_plus: "Copilot Pro+", business: "Copilot Business", enterprise: "Copilot Enterprise", max: "Copilot Max" };
  return `Plan: ${names[plan] ?? wordsOf(plan)}`;
}
export const CONTEXT = "Context window";
export const CONTEXT_EMPTY = "The session has no context yet: send it a message first.";
export function contextLine(c: { total: number; limit: number }): string { return `${tokenCount(c.total)} of ${tokenCount(c.limit)} tokens`; }
export function contextParts(c: { system: number; conversation: number; tools: number; mcp: number }): string {
  return `Instructions ${tokenCount(c.system)} · conversation ${tokenCount(c.conversation)} · tool descriptions ${tokenCount(c.tools)}${c.mcp ? `, of which servers' ${tokenCount(c.mcp)}` : ""}`;
}
export function compactsAt(n: number): string { return n ? `Copilot compacts on its own at ${tokenCount(n)} tokens.` : ""; }
export function contextMeter(c: { total: number; limit: number }, pct: number): string { return `Context used: ${pct}%, ${contextLine(c)}`; }
export const HEAVIEST = "Largest parts";
export function heavyLine(m: { tokens: number; share: number }): string { return `${tokenCount(m.tokens)} tokens · ${m.share}%`; }
export const COMPACT = "Compact now";
export const COMPACT_LEAD = "Compacting replaces the conversation so far with a summary, which frees room in the context. The transcript stays as it is; Copilot keeps working from the summary.";
export const COMPACT_QUESTION = "Compact the conversation now?";
export const COMPACT_BUSY = "Copilot is working. Compact when the turn ends.";
export function compactedWords(r: { ok: boolean; tokens: number; messages: number }): string {
  return r.ok ? `Compacted: ${tokenCount(r.tokens)} tokens and ${r.messages.toLocaleString("en-GB")} ${r.messages === 1 ? "message" : "messages"} freed.` : "Copilot couldn't compact the conversation.";
}
