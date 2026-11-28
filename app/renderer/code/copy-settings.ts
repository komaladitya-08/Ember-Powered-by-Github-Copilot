/**
 * The words of Customise › Defaults and Customise › Session settings (docs/CODING-APP.md §8): the person's defaults
 * for new sessions, a project's instructions for Copilot and extra folders, and a session's options. Pure, sentence
 * case, British spelling. Pinned in test/unit/code-settings-copy.test.ts.
 */

export const DEFAULTS_SECTION = "Defaults";
export const SESSION_SETTINGS_SECTION = "Session settings";

export const DEFAULTS_EVERYONE = "For every project";
export const DEFAULTS_EVERYONE_LEAD = "What a new session starts with when you don't choose. A project's own choice below wins over these, and your organisation's rules over both.";
export const DEFAULTS_PROJECT = "For this project";
export const DEFAULTS_PROJECT_CHOOSE = "Project";
export const DEFAULTS_NO_PROJECT = "Add a project to give it settings of its own.";
export const SAME_AS_EVERYONE = "As for every project";
export const NOT_SET = "Copilot's own";
export const DEFAULT_WHERE = "Where it works";
export const DEFAULT_IN_FOLDER = "In the folder";
export const DEFAULT_IN_WORKTREE = "In a new worktree (git projects)";
export const DEFAULT_PERMISSIONS = "Permissions";
export const DEFAULT_AGENT_MODE = "Agent mode";
export const DEFAULT_MODEL_LABEL = "Model";
export const DEFAULT_EFFORT_LABEL = "Reasoning effort";
export const SAVE_DEFAULTS = "Save defaults";
export const DEFAULTS_SAVED = "Saved. New sessions start with these.";
export function modeNotAllowed(name: string): string { return `${name} (not allowed by your organisation)`; }

export const INSTRUCTIONS = "Instructions for Copilot";
export const INSTRUCTIONS_LEAD = "Copilot reads these in every session of this project, beside the repository's own instruction files. They're yours: Copilot never writes them.";
export const INSTRUCTIONS_SAVE = "Save instructions";
export const INSTRUCTIONS_SAVED = "Saved. Sessions read them as they start or open again.";
export function instructionsCount(n: number, max: number): string { return `${n.toLocaleString("en-GB")} of ${max.toLocaleString("en-GB")} characters`; }

export const FOLDERS = "Extra folders";
export const FOLDERS_LEAD = "Folders this project's sessions may also work in. Copilot asks before it reads or changes them, as for any folder outside the project.";
export const FOLDERS_EMPTY = "No extra folders.";
export const FOLDER_ADD = "Add folder…";
export const FOLDER_REMOVE = "Remove";
export function folderRemoveLabel(folder: string): string { return `Remove ${folder}`; }
export const FOLDERS_NEXT = "Sessions use the change as they start or open again.";

export const SUMMARY = "Reasoning summaries";
export const SUMMARY_LEAD = "How much of the model's reasoning Copilot shows, where the model gives it.";
export function summaryName(v: string): string {
  if (v === "none") return "None";
  if (v === "concise") return "Short";
  if (v === "detailed") return "Detailed";
  return "Copilot's own";
}
export const LONG_CONTEXT = "Long context";
export const LONG_CONTEXT_LEAD = "Lets a model that has a longer context window use it. It may cost more.";
export const COAUTHOR = "Name Copilot as co-author of commits";
export const CREDIT_LIMIT = "AI credit limit";
export const CREDIT_LIMIT_LEAD = "Copilot stops and asks you when the session reaches it. Leave it empty for no limit.";
export const NO_CREDIT_LIMIT = "No limit";
export const CREDIT_LIMIT_BAD = "Type a whole number of credits, or leave it empty.";
export function creditsRecommended(cap: number): string { return `Copilot suggests about ${cap.toLocaleString("en-GB")} credits for a session like this.`; }
export const TOOLS = "Built-in tools";
export const TOOLS_LEAD = "Turn a tool off to keep this session from using it. Turning one off never lets anything else through.";
export const TOOLS_EMPTY = "Open the session to list its tools.";
export const SAVE_SESSION_SETTINGS = "Save session settings";
export const SESSION_SETTINGS_SAVED = "Saved. Copilot uses them from its next step.";
export function toolLabel(name: string, title?: string): string { return title && title !== name ? `${name} (${title})` : name; }
