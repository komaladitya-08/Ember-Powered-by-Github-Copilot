/** Conversation bounds, shared by the host, Home and the opt-in saved copy (app/main/agent/conversation-store.ts). Nothing here writes to disk. */
export const CONVERSATION_LIMIT = 60;
export const CONVERSATION_TEXT_LIMIT = 128 * 1024;
export const CONVERSATION_REQUEST_LIMIT = 2000;

/** What can be wrong with the saved conversation (conversation-store.ts HistoryProblem), told beside its switch. */
export type HistoryProblemKind = "exposed" | "delete" | "unchecked" | "save" | "owner" | "account";

/** Keep long answers readable, with an explicit signal if the memory bound is reached. */
export function retainedConversationText(text: string): { text: string; truncated?: true } {
  if (text.length <= CONVERSATION_TEXT_LIMIT) return { text };
  let kept = text.slice(0, CONVERSATION_TEXT_LIMIT);
  // Never leave half of an emoji at the boundary.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return { text: kept, truncated: true };
}

/** A new, explicitly submitted typed request. Earlier tools or voice/suggestion trust are never replayed. */
export function conversationRequest(input: unknown): string | null {
  if (typeof input !== "string" || input.length > CONVERSATION_REQUEST_LIMIT) return null;
  return input.trim() || null;
}
