/**
 * Command output that reads like instructions to Ember (design §3.11 step 7, critique security-7). A match marks the
 * task tainted, after which every command asks (§3.8.2 rule 7). Best effort (L26): static patterns can't read intent,
 * so the classifier and the verbatim card stay the guard for anything dangerous. Pure; run on the shaped text after
 * secret removal and before the output is cut to size, so nothing hides in the middle.
 */

/** One pattern and the reason recorded when it matches (the audit's `rule`). */
interface TaintRule { re: RegExp; why: string }

const RULES: readonly TaintRule[] = [
  // Text addressed to an assistant or agent.
  { re: /(ignore|disregard) (all |any )?(previous|prior|above) (instructions|directions)/i, why: "output.ignore-instructions" },
  { re: /\b(you are|you're) (now )?(an? )?(ai|assistant|agent)\b/i, why: "output.you-are-an-assistant" },
  { re: /\b(assistant|system|developer)\s*:/i, why: "output.role-label" },
  { re: /<\/?(system|instructions?|prompt)>/i, why: "output.role-tag" },
  { re: /\bas an ai\b/i, why: "output.as-an-ai" },
  // Download-and-run text.
  { re: /curl[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, why: "output.curl-pipe-shell" },
  { re: /wget[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, why: "output.wget-pipe-shell" },
  { re: /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(iex|invoke-expression)\b/i, why: "output.iwr-pipe-iex" },
  { re: /base64\s+-d[^\n|]*\|\s*(ba|z)?sh\b/i, why: "output.base64-pipe-shell" },
  // A request to run, paste or type something, addressed to Ember, the assistant or the agent.
  { re: /\b(ember|assistant|agent)\s*[,:]\s*(please\s+)?(now\s+)?(run|execute|paste|type|enter)\b/i, why: "output.addressed-request" },
  { re: /\bif you('re| are) (an? )?(ai|llm|language model|assistant|agent|ember)\b[^\n]{0,80}\b(run|execute|paste|type)\b/i, why: "output.addressed-request" },
  { re: /\b(the |an? )?(ai )?(assistant|agent)\s+(should|must|needs to|has to|is to|will)\s+(now\s+)?(run|execute|paste|type)\b/i, why: "output.addressed-request" },
  { re: /\bember\b[^\n]{0,40}\b(should|must|please|needs to)\b[^\n]{0,20}\b(run|execute|paste|type)\b/i, why: "output.addressed-request" },
  { re: /\b(note|message|instructions?) (to|for) (the )?(ai|assistant|agent|ember)\b/i, why: "output.addressed-request" },
];

/** The reason the shaped output reads like instructions to Ember (§3.11 step 7), or null. */
export function outputTaint(text: string): string | null {
  for (const r of RULES) if (r.re.test(text)) return r.why;
  return null;
}
