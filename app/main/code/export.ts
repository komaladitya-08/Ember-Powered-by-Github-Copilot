/**
 * A coding session's transcript as Markdown, for a file the person chose in main's own save dialog (docs/CODING-APP.md
 * §8 "Export"): their messages, Copilot's replies, and each tool call by its name and, for a command, its command
 * line; errors as Ember's plain sentence. Built from the SDK's own kept events (`sessions.readPersistedEvents`), already
 * redacted as events are (vault values, tokens), never a file's contents, a tool's output, reasoning or an image.
 * Pure: no I/O. Unit-tested in test/unit/code-storage.test.ts.
 */

/** Characters of one message the file keeps at most. */
const MESSAGE_MAX = 100_000;

type Ev = { type: string; timestamp?: string; data: unknown };
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown, max = MESSAGE_MAX): string => (typeof v === "string" ? (v.length > max ? `${v.slice(0, max)}…` : v) : "");

/** A fenced block that its own text can't end (a fence longer than any run of backticks in it). */
function fenced(body: string, lang = ""): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map(m => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** The transcript of `events` as Markdown, under `title`, with the session's folder and when it was exported. */
export function transcriptMarkdown(events: readonly Ev[], o: { title: string; folder: string; at: Date }): string {
  const out: string[] = [`# ${o.title.replace(/\s+/g, " ").trim() || "Coding session"}`, "", `Folder: ${o.folder}  `, `Exported: ${o.at.toISOString()}`, ""];
  const tools = new Map<string, string>();
  for (const e of events) {
    const d = rec(e.data);
    // A sub-agent's own steps nest under its tool call in the window; the file keeps the main agent's.
    if (typeof d.parentToolCallId === "string") continue;
    switch (e.type) {
      case "user.message": {
        const words = text(d.content);
        if (words.trim()) out.push("## You", "", words, "");
        break;
      }
      case "assistant.message": {
        const words = text(d.content);
        if (words.trim()) out.push("## Copilot", "", words, "");
        break;
      }
      case "tool.execution_start": case "tool.user_requested": {
        const args = rec(d.arguments);
        const shell = rec(d.shellToolInfo);
        const command = text(shell.displayCommand, 4_000) || text(args.command, 4_000);
        const name = text(d.toolName, 200) || text(d.toolTitle, 200) || "tool";
        const line = e.type === "tool.user_requested" ? "You ran a command:" : command ? `Copilot ran a command (${name}):` : `Copilot used ${name}${typeof args.path === "string" ? ` on ${text(args.path, 4_000)}` : ""}.`;
        out.push(`> ${line}`, ...(command ? ["", fenced(command, "sh")] : []), "");
        if (typeof d.toolCallId === "string") tools.set(d.toolCallId, name);
        break;
      }
      case "tool.execution_complete":
        if (d.success === false && typeof d.toolCallId === "string") out.push(`> ${tools.get(d.toolCallId) ?? "A tool"} didn't finish.`, "");
        break;
      case "session.error": out.push("> Copilot ran into a problem and stopped that turn.", ""); break;
      case "abort": out.push("> Stopped.", ""); break;
      default: break;
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** A file name for a session's export: its title's words, safe on every OS, ending ".md". */
export function exportName(title: string): string {
  const base = title.normalize("NFKC").replace(/[^\p{L}\p{N} _-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || "Coding session"}.md`;
}
