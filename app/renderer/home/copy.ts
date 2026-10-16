/** The settings window's words: pure functions, so they are unit-tested. */

import type { ActivityEntry } from "../../shared/ipc";

/** What a fresh install never looks at (the same list as the settings defaults). */
export const NEVER_LOOK_DEFAULTS: readonly string[] = ["keepassxc", "seahorse", "passwords and keys", "1password", "bitwarden", "polkit"];

/** How the defaults read on screen (they are stored lower-case, as matched). */
const NEVER_LOOK_NAMES: Record<string, string> = {
  keepassxc: "KeePassXC",
  seahorse: "Seahorse",
  "passwords and keys": "Passwords and Keys",
  "1password": "1Password",
  bitwarden: "Bitwarden",
  polkit: "Password prompts (polkit)",
};

export function neverLookLabel(item: string): string {
  return NEVER_LOOK_NAMES[item.trim().toLowerCase()] ?? item;
}

/** The defaults that are missing from `list` (case-insensitive). */
export function missingDefaults(list: readonly string[]): string[] {
  const have = new Set(list.map(x => x.trim().toLowerCase()));
  return NEVER_LOOK_DEFAULTS.filter(d => !have.has(d));
}

export { friendlyApp } from "../../shared/apps";
import { friendlyApp } from "../../shared/apps";

/** Token counts that read naturally: "312", "1.2k", "48k". */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

export function usageLine(u: { calls: number; inputTokens: number; outputTokens: number }): string {
  if (!u.calls) return "";
  return `This session: ${u.calls} model ${u.calls === 1 ? "call" : "calls"}, ${tokens(u.inputTokens)} tokens in, ${tokens(u.outputTokens)} tokens out.`;
}

/** Where "Check again" found a sign-in. */
const SOURCE_TEXT: Record<string, string> = {
  stored: "Ember's saved sign-in",
  environment: "a GitHub token in the environment",
  "github-cli": "your GitHub CLI sign-in",
};

export function retryMessage(r: { found: boolean; source: string | null }, connected = false): string {
  if (!r.found) return "No GitHub sign-in found on this computer. Run “gh auth login” in a terminal, then press Check again.";
  const what = SOURCE_TEXT[r.source ?? ""] ?? "a GitHub sign-in";
  return `Found ${what}; ${connected ? "connected." : "connecting…"}`;
}

/** The line under "Ember" at the top of the window. */
export function tagline(t: {
  failing: number; onboarded: boolean; phase: string | null; hidden: boolean; overlay: boolean; waitingForTasks?: boolean;
}): string {
  if (t.failing) return "Ember needs a couple of things fixed before it can work on this machine.";
  if (!t.onboarded) return "Read how Ember works, pick who keeps you company, then agree and press Start.";
  const where = !t.overlay ? "Ember is in the bottom-right corner." : t.hidden ? "Ember is hidden for now." : "Ember is beside your cursor.";
  if (t.phase === "error" && t.waitingForTasks) return `${where} Copilot isn't answering: Ember reconnects once the tasks running are done.`;
  if (t.phase === "signed-out" || t.phase === "error") return `${where} Connect Copilot below to start asking.`;
  if (t.phase === "starting" || t.phase === null) return `${where} Connecting to Copilot…`;
  return `${where} Press Ctrl+Alt+Space to ask it anything.`;
}

/** "Today", "Yesterday", else the weekday and date. */
export function dayLabel(t: string, now = new Date()): string {
  const d = new Date(t);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/** Download progress for screen readers: only at 0, 25, 50, 75 and 100 %. */
export function progressStep(fraction: number): number {
  return Math.min(100, Math.floor(Math.max(0, fraction) * 4) * 25);
}

const KIND: Record<string, string> = {
  click: "Click", toggle: "Switch", text: "Type into", select: "Choose in", value: "Set", setting: "Change setting", open_app: "Open",
  cursor_click: "Click (your mouse)", cursor_text: "Type (your keyboard)", keys: "Press keys", scroll: "Scroll", point: "Point at", read: "Read",
};
/** Plain words for an unnamed control's role. */
const ROLE: Record<string, string> = {
  "push button": "a button", button: "a button", "toggle button": "a switch", switch: "a switch", "check box": "a checkbox",
  "radio button": "an option", text: "a text field", entry: "a text field", "password text": "a password field",
  "combo box": "a drop-down", "menu item": "a menu item", "list item": "a list item", link: "a link", slider: "a slider",
  "spin button": "a number field", "page tab": "a tab",
};

export interface EntryView { tag: string; cls: string; what: string; why?: string }

const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", meta: "Super", return: "Enter", enter: "Enter",
  escape: "Esc", esc: "Esc", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space", up: "Up", down: "Down",
  left: "Left", right: "Right", home: "Home", end: "End", pageup: "Page Up", page_up: "Page Up", prior: "Page Up",
  pagedown: "Page Down", page_down: "Page Down", next: "Page Down", insert: "Insert",
};
/** A key as people write it: "ctrl+s" → "Ctrl+S", "Return" → "Enter". */
export function keyLabel(key: string): string {
  return key.split("+").map(part => {
    const k = part.trim();
    return KEY_NAMES[k.toLowerCase()] ?? (k.length === 1 || /^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k);
  }).join("+");
}

/** One line of "What Ember did", or null for entries that the next line already says. */
export function describeEntry(e: ActivityEntry): EntryView | null {
  // A named control is called by its name ("Switch “Night Light”"); the role only when there is no name.
  const control = e.element ? (e.element.name ? `“${e.element.name}”` : ROLE[e.element.role] ?? e.element.role) : e.value ? `“${e.value}”` : "";
  const where = e.app ? `in ${friendlyApp(e.app)}` : "";
  const target = [control, where].filter(Boolean).join(" ");
  const chosen = typeof e.value === "string" && e.value ? e.value : "";
  // Keys say which ("Press Ctrl+S in Mousepad"): the field they went to adds nothing.
  const what = e.kind === "keys"
    ? [chosen ? `Press ${keyLabel(chosen)}` : "Press keys", where].filter(Boolean).join(" ")
    // The option chosen, and what it was chosen for: "Choose “Vegetarian” for “Meal” in Firefox".
    : e.kind === "select" && chosen && e.element
      ? [`Choose “${chosen}”`, e.element.name ? `for “${e.element.name}”` : "", where].filter(Boolean).join(" ")
      // A guide step the user did themselves (a click, or Enter or Space on it).
      : e.kind === "user_clicked" ? `You used ${target || "it"}`
        : `${KIND[e.kind ?? ""] ?? e.kind ?? ""} ${target}`.trim();
  switch (e.event) {
    case "task":
      if (e.phase === "asked") return { tag: e.mode === "guide" ? "Guide" : "Task", cls: "", what: String(e.goal ?? "") };
      if (e.phase === "done") return { tag: "Finished", cls: "ok", what: String(e.summary ?? e.goal ?? "") };
      return { tag: e.phase === "cancelled" ? "Stopped" : "Failed", cls: "no", what: String(e.goal ?? ""), why: typeof e.summary === "string" ? e.summary : undefined };
    case "decision":
      // Several cells filled with one question (fill_cells): one line for them all, on the last cell's decision.
      if (typeof e.batch === "number") {
        if (e.at !== e.batch - 1 || (e.batchVerdict !== "ask" && e.batchVerdict !== "deny")) return null;
        const fill = [`Fill ${e.batch} cells (your keyboard)`, where].filter(Boolean).join(" ");
        return { tag: e.batchVerdict === "deny" ? "Refused" : "Asked you", cls: e.batchVerdict === "deny" ? "no" : "ask", what: fill, why: typeof e.batchReason === "string" ? e.batchReason : undefined };
      }
      if (e.verdict === "allow") return null; // the action line that follows says it
      return { tag: e.verdict === "deny" ? "Refused" : "Asked you", cls: e.verdict === "deny" ? "no" : "ask", what, why: e.reason };
    case "confirm":
      return { tag: e.answer === "once" || e.answer === "always" ? "You allowed" : e.answer === "deny" ? "You said no" : e.answer === "stopped" ? "Stopped" : "No answer", cls: e.answer === "once" || e.answer === "always" ? "ok" : "no", what };
    case "action":
      return { tag: e.ok ? "Done" : "Didn't work", cls: e.ok ? "ok" : "no", what: `${what}${e.tier === 2 ? " (on Ember's desk)" : ""}`, why: e.error };
    case "stop":
      return { tag: "Stopped", cls: "no", what: `Everything stopped (${e.source === "hotkey" ? "Ctrl+Alt+X" : e.source === "voice" ? "“Ember, stop”" : "menu"})` };
    default:
      return null;
  }
}
