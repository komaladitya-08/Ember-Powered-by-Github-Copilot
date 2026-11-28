/**
 * A session's lifecycle actions in the command palette (docs/CODING-APP.md §8): export its transcript as Markdown
 * (main's `exportSession`, into a file main's save dialog chooses), and start a new session from Copilot's summary of
 * this one (`history.summarizeForHandoff`, then a new session in the same project with the summary left as a draft
 * in its message box: nothing is sent until the person sends it).
 */
import type { CodeSessionRow } from "../../shared/code";
import type { CodeApp } from "./app";
import { EXPORTED, HANDOFF_WORKING, handoffDraft } from "./copy-storage";
import { str } from "./sdk";
import { setDraft, setNote } from "./store";

/** Saves the session's transcript where the person chooses; says how it went under the message box. */
export async function exportSession(app: CodeApp, row: CodeSessionRow): Promise<void> {
  if (!app.api.exportSession) return;
  const r = await app.api.exportSession(row.id).catch(() => null);
  app.set(s => setNote(s, row.id, "composer", !r ? "" : r.ok ? EXPORTED : r.reason));
}

/** A new session in the same project, its draft Copilot's summary of this one. Returns its id, or null. */
export async function handoff(app: CodeApp, row: CodeSessionRow): Promise<string | null> {
  app.set(s => setNote(s, row.id, "composer", HANDOFF_WORKING));
  const r = await app.rpc({ scope: "session", sessionId: row.id, method: "history.summarizeForHandoff", params: {} });
  const summary = r.ok ? str(r.value, "summary", true) ?? "" : "";
  app.set(s => setNote(s, row.id, "composer", r.ok ? "" : r.reason));
  if (!r.ok || !summary.trim()) return null;
  const id = await app.create({ projectId: row.projectId, isolation: row.isolation === "worktree" ? "worktree" : "folder" });
  if (id) app.set(s => setDraft(s, id, { text: handoffDraft(summary), attachments: [] }));
  return id;
}
