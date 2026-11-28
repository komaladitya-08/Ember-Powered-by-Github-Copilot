/**
 * How a panel tab hands files to the composer (the Files tab's "Attach to message"): a document event the composer
 * listens for, carrying the session it is for and file attachments whose paths came from main's or the SDK's own lists.
 * The composer takes them as it takes its picker's results; main checks every path again when the message is sent.
 */
import type { CodeAttachment } from "../../shared/code";
import { rec } from "./sdk";

/** The event's name. */
export const ATTACH_EVENT = "ember-code:attach";

/** The file attachments an event's detail carries for `sessionId` (null: none, or for another session). */
export function attachmentsOf(detail: unknown, sessionId: string | null): CodeAttachment[] | null {
  const d = rec(detail);
  if (!d || !sessionId || d.sessionId !== sessionId || !Array.isArray(d.attachments)) return null;
  const out: CodeAttachment[] = [];
  for (const a of d.attachments) {
    const o = rec(a);
    if (!o || o.type !== "file" || typeof o.path !== "string" || !o.path) continue;
    out.push({ type: "file", path: o.path, ...(typeof o.displayName === "string" && o.displayName ? { displayName: o.displayName } : {}) });
  }
  return out;
}
