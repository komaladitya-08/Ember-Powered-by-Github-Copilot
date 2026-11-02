/**
 * What Ember says straight away when a spoken request is taking Copilot a moment (docs/ASSISTANT.md phase 1.3, the
 * Jarvis research's J1): JARVIS's "Will do, sir" without the "sir". A 2025 study found every filler shortened how long
 * the wait felt, and fillers that fit the request ("Let me check…") also raised rapport; a 2026 study found a short
 * generic filler no better than silence. So Ember says one only when the request's shape tells which fits, and nothing
 * otherwise. Pure and English-only: requests in other languages get no acknowledgement.
 *
 * It promises nothing about the outcome: Ember still asks before anything risky, and Copilot's answer follows it.
 */

/** How long Copilot may take to start answering a spoken request before Ember acknowledges it. */
export const ACK_MS = 700;

const LOOK = /\b(?:screen|window|tab|page|this|that|here|open|showing|selected)\b/;
const QUESTION = /^(?:what|what's|whats|how|how's|why|when|where|who|which|can|could|is|are|do|does|did|will|would|should|have|has)\b/;
const SHOW = /^(?:show me|how do i|how can i|where(?:'s| is)|teach me|walk me through)\b/;
const DO = /^(?:please |can you |could you |would you )?(?:open|close|turn|switch|set|change|make|create|add|put|send|write|draft|type|fill|move|copy|rename|save|find|search|look up|start|run|tidy|clean|sort|organi[sz]e|delete|remove|empty|check|go to|take|play|pause|mute|unmute|install|update|edit|fix|reply|book|schedule|remind)\b/;
const NOTE = /^(?:remember|note|forget)\b/;

/**
 * The answer's first words to speak once `ack` was said: without the acknowledgement it starts with ("On it." then "On
 * it, opening Mail." would say it twice). "" when nothing is left.
 */
export function afterAck(chunk: string, ack: string | null): string {
  if (!ack) return chunk;
  const words = ack.replace(/[.!…]+$/u, "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const m = new RegExp(`^\\s*${words}(?:[.!,…:;-]+|\\s*$)\\s*`, "iu").exec(chunk);
  return m ? chunk.slice(m[0].length) : chunk;
}

/** The acknowledgement that fits `request` (its words as heard), or null when none clearly does. */
export function acknowledgement(request: string): string | null {
  const t = request.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/^(?:hey |ok |okay |so )?(?:ember[, ]+)?/, "");
  if (t.split(/\s+/).length < 2) return null;
  if (NOTE.test(t)) return "Got it.";
  if (SHOW.test(t)) return "Let me show you.";
  if (DO.test(t)) return "On it.";
  if (QUESTION.test(t)) return LOOK.test(t) ? "Let me look." : "Let me check.";
  return null;
}
