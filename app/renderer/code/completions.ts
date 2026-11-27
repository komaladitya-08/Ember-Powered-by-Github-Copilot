/**
 * The composer's completions as pure functions: where a trigger ("@", "/" or what the session's
 * `completions.getTriggerCharacters` names) starts the word at the caret, what accepting an item does to the text
 * (`completions.request`'s own range when it gives one), the slash commands that match from `commands.list`, and the
 * popup's keyboard movement. The DOM half is composer.ts. Unit-tested in test/unit/code-completions.test.ts.
 */
import { arr, bool, str, strs } from "./sdk";

/** A trigger at the start of the word the caret is in. */
export interface Trigger { char: string; start: number; query: string }

/**
 * The trigger whose word the caret is at the end of: the character starts the text or follows white space, and no
 * white space comes between it and the caret. A "/" counts only at the start of the message (a slash command), so a
 * path typed in a sentence doesn't open the popup.
 */
export function triggerAt(text: string, caret: number, triggers: readonly string[]): Trigger | null {
  if (caret < 1 || caret > text.length) return null;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (/\s/.test(ch)) return null;
    if (triggers.includes(ch) && (i === 0 || /\s/.test(text[i - 1]))) {
      if (ch === "/" && text.slice(0, i).trim()) return null;
      return { char: ch, start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

/** One row of the popup. */
export interface CompletionItem { label: string; insertText: string; detail?: string; kind?: string; rangeStart?: number; rangeEnd?: number }

/** `completions.request`'s items, read (an item with no text to insert is left out). */
export function completionItems(result: unknown): CompletionItem[] {
  return arr(result, "items").map(i => {
    const insertText = str(i, "insertText", true) ?? "";
    const rs = typeof (i as Record<string, unknown>)?.rangeStart === "number" ? (i as { rangeStart: number }).rangeStart : undefined;
    const re = typeof (i as Record<string, unknown>)?.rangeEnd === "number" ? (i as { rangeEnd: number }).rangeEnd : undefined;
    return { label: str(i, "label") ?? insertText, insertText, ...(str(i, "kind") ? { kind: str(i, "kind") } : {}), ...(rs !== undefined ? { rangeStart: rs } : {}), ...(re !== undefined ? { rangeEnd: re } : {}) };
  }).filter(i => i.insertText);
}

/** A slash command as `commands.list` gives it. */
export interface SlashCommand { name: string; aliases: string[]; description: string; duringTurn: boolean; hint?: string }
export function slashCommands(result: unknown): SlashCommand[] {
  return arr(result, "commands").map(c => ({
    name: str(c, "name") ?? "", aliases: strs(c, "aliases"), description: str(c, "description", true) ?? "",
    duringTurn: bool(c, "allowDuringAgentExecution") ?? false, ...(str((c as Record<string, unknown>)?.input, "hint") ? { hint: str((c as Record<string, unknown>).input, "hint") } : {}),
  })).filter(c => c.name);
}

/** The slash commands that start with `query` (by name, then by an alias), as popup rows. */
export function slashItems(commands: readonly SlashCommand[], query: string, busy = false): CompletionItem[] {
  const q = query.toLocaleLowerCase();
  const rank = (c: SlashCommand) => (c.name.toLocaleLowerCase().startsWith(q) ? 0 : c.aliases.some(a => a.toLocaleLowerCase().startsWith(q)) ? 1 : c.name.toLocaleLowerCase().includes(q) ? 2 : 3);
  return commands.filter(c => (!busy || c.duringTurn) && rank(c) < 3)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 50)
    .map(c => ({ label: `/${c.name}`, insertText: `/${c.name} `, detail: c.description, kind: "command" }));
}

/**
 * The text and caret after accepting `item` for `trigger`: the item's own range where it gives one (UTF-16 offsets
 * into the text), else the trigger's word up to the caret.
 */
export function accept(text: string, caret: number, trigger: Trigger, item: CompletionItem): { text: string; caret: number } {
  const valid = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n) && n >= 0 && n <= text.length;
  const start = valid(item.rangeStart) ? item.rangeStart : trigger.start;
  const end = valid(item.rangeEnd) && item.rangeEnd >= start ? item.rangeEnd : caret;
  // A trailing space after an accepted word lets the person type on; one is added where the item has none and none follows.
  const insert = item.insertText.endsWith(" ") || text[end] === " " ? item.insertText : `${item.insertText} `;
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/** The highlighted row after a key: Arrow keys wrap, Home and End go to the ends; -1 for no rows. */
export function moveHighlight(index: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return Math.min(Math.max(index, 0), count - 1);
}
