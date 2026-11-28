/**
 * A unified diff as rows Home's chats and the coding window draw: each line a kind (added, removed, unchanged, a hunk's or a file's
 * header) with its line numbers, so added and removed lines are told apart by a sign and by words for screen readers,
 * never by colour alone (WCAG 1.4.1). The diff is the SDK's text, shown as it is, never interpreted. Pure.
 */

export type DiffKind = "add" | "del" | "ctx" | "hunk" | "file" | "note";

export interface DiffRow {
  kind: DiffKind;
  /** The line without its leading sign. */
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** The most rows a diff shows; the rest is counted. */
export const DIFF_ROWS_MAX = 1500;

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** `diff`'s rows, at most `max` (`more`: how many lines were left out). */
export function diffRows(diff: string, max = DIFF_ROWS_MAX): { rows: DiffRow[]; more: number; added: number; removed: number } {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const rows: DiffRow[] = [];
  let oldNo = 0, newNo = 0, inHunk = false, added = 0, removed = 0, more = 0;
  const push = (r: DiffRow) => { if (rows.length < max) rows.push(r); else more++; };
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]); newNo = Number(hunk[2]); inHunk = true;
      push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.startsWith("diff ")) inHunk = false;
      push({ kind: line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff ") ? "file" : "note", text: line });
      continue;
    }
    if (line.startsWith("+")) { added++; push({ kind: "add", text: line.slice(1), newNo: newNo++ }); }
    else if (line.startsWith("-")) { removed++; push({ kind: "del", text: line.slice(1), oldNo: oldNo++ }); }
    else if (line.startsWith("\\")) push({ kind: "note", text: line });
    else push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ });
  }
  return { rows, more, added, removed };
}
