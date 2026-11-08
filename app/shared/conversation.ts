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

/**
 * Whether the conversation is answering a request, as main knows it (home-c1-1): "thinking" from the moment a request
 * is asked until its turn ends (or it is stopped, dropped or answered), "slow" while the bubble says Ember is still
 * waiting for the model service, "held" while what was asked waits, unsent, for a switch of model service that waits
 * for the work under way, with nothing answering meanwhile (home-r4-4), else "idle". Home's composer and status panel
 * say this, never a guess of their own.
 */
export type ConversationTurn = "idle" | "thinking" | "slow" | "held";

/** A turn state as main pushes it, or null for anything else. */
export function conversationTurnOf(value: unknown): ConversationTurn | null {
  return value === "idle" || value === "thinking" || value === "slow" || value === "held" ? value : null;
}

/**
 * How the turn Home was told of ended, when a Stop ended it (home-c2-2): "stopped" by the conversation's Stop (Home's
 * Stop response, the bubble's Stop, New conversation), "stopped-everything" by the kill switch. Any other end has none:
 * Home says what the lines that came since its request show, which main sends before the turn's end (home-r2-1).
 */
export type ConversationTurnEnd = "stopped" | "stopped-everything";

/** The conversation's turn as main pushes it to Home: its state, and with "idle" how a Stop ended it. */
export interface ConversationTurnChange { turn: ConversationTurn; ended?: ConversationTurnEnd }

/** A turn change as main pushes it (or a bare state, as Home's conversationTurn() answers), or null for anything else. */
export function conversationTurnChangeOf(value: unknown): ConversationTurnChange | null {
  const bare = conversationTurnOf(value);
  if (bare) return { turn: bare };
  if (typeof value !== "object" || value === null) return null;
  const v = value as { turn?: unknown; ended?: unknown };
  const turn = conversationTurnOf(v.turn);
  if (!turn) return null;
  return turn === "idle" && (v.ended === "stopped" || v.ended === "stopped-everything") ? { turn, ended: v.ended } : { turn };
}

/**
 * What became of a request Home's composer sent: "stopped" for a typed "stop" that stopped everything at once (a task
 * was at work: no turn comes for it), else "sent".
 */
export type ConversationSent = "sent" | "stopped";
