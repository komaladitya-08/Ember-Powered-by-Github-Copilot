/**
 * "Work without asking" by voice (owner decision of 2026-11-02): "Ember, work without asking" or "stop asking for
 * permission" turns it on, "ask me first again" turns it off. Answered in the host, as status.ts's questions are, with
 * no Copilot turn and no conductor tool: the model can neither hear of it as a tool nor turn it on.
 *
 * Turning it on needs the owner's own voice (a Voice Match-verified utterance) and the feature's card already agreed
 * to; otherwise Ember opens the switch (and its card) in Settings and says why. Turning it off works for anyone, typed
 * or spoken. Every reply is built here, in Ember's words. Pure, so it is unit-tested without Electron.
 */

/** What may come before: the name, "hey Ember", "ok", "please". */
const LEAD = String.raw`(?:(?:hey|ok|okay|so)[,\s]+)?(?:ember[,\s]+)?(?:please[,\s]+)?(?:(?:can|could|will|would) you[,\s]+)?`;
/** What may come after: "please", "from now on", the name again. */
const TAIL = String.raw`(?:[,\s]+(?:please|from now on|for now|now|thanks|ember))*`;

const ON = [
  String.raw`(?:turn on |switch on |start )?work(?:ing)? without asking(?: me)?(?: first)?`,
  String.raw`stop asking(?: me)?(?: for (?:permission|approval)| first| before (?:you do things|each step|everything))?`,
  String.raw`(?:you )?(?:don't|do not) (?:need to |have to )?ask (?:me )?(?:for (?:permission|approval)|first|before (?:you do things|each step|everything))`,
  String.raw`no more (?:permission|approval) (?:questions|prompts)`,
];
const OFF = [
  String.raw`ask me first(?: again)?`,
  String.raw`(?:start )?ask(?:ing)? (?:me )?(?:for (?:permission|approval)|before (?:you do things|each step|anything|everything)) again`,
  String.raw`(?:turn off |switch off |stop )work(?:ing)? without asking`,
  String.raw`(?:always )?check with me first(?: again)?`,
];

const ON_RE = new RegExp(String.raw`^${LEAD}(?:${ON.join("|")})${TAIL}$`, "i");
const OFF_RE = new RegExp(String.raw`^${LEAD}(?:${OFF.join("|")})${TAIL}$`, "i");

const norm = (text: string) => text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[\s?!.…]+$/u, "").replace(/\s+/g, " ");

/** Does the whole of `text` turn "Work without asking" on or off (null: neither; the conversation's)? */
export function autonomyIntent(text: string): "on" | "off" | null {
  const t = norm(text);
  if (!t || t.length > 80) return null;
  if (OFF_RE.test(t)) return "off";
  return ON_RE.test(t) ? "on" : null;
}

/** What the host knows when the intent comes. */
export interface AutonomyIntentState {
  /** It is on now. */
  on: boolean;
  /** Its card was agreed to (FEATURE_CONSENT_VERSION.autonomy). */
  consented: boolean;
  /** The administrator doesn't allow it. */
  managed: boolean;
  /** Heard, and verified by Voice Match as the owner's voice. */
  verified: boolean;
  /** Voice Match matched the owner's voice, but on too little of it to vouch for it (match.ts APPROVAL_MIN_SECONDS). */
  short?: boolean;
}

/** What to do: change the setting (`set`), open its switch in Settings (`open`, with its card when `consent`), and say `reply`. */
export interface AutonomyIntentPlan { set?: boolean; open?: { consent: boolean }; reply: string }

/** Said instead of the plan's reply when the change couldn't be saved or recorded (a turn on is then undone). */
export const AUTONOMY_NOT_SAVED = "I couldn't save or record that change, so I'll keep asking you first.";

/** The plan for `intent` (pure: the host carries it out). */
export function planAutonomyIntent(intent: "on" | "off", s: AutonomyIntentState): AutonomyIntentPlan {
  if (intent === "off") {
    return s.on ? { set: false, reply: "Okay, I'll ask you first again." } : { reply: "I already ask you first." };
  }
  if (s.managed) return { reply: "Your organisation doesn't allow that, so I'll keep asking first." };
  if (s.on) return { reply: "I'm already working without asking. I still ask before anything risky, and “Ember, stop” stops me." };
  if (!s.consented) return { open: { consent: true }, reply: "First have a look at what that means: I've opened it in Settings. Agree there, and I'll work without asking." };
  if (!s.verified && s.short) return { reply: "Say a little more so I can be sure it's you: “Ember, please work without asking from now on.”" };
  if (!s.verified) return { open: { consent: false }, reply: "I can turn that on by voice only once Voice Match knows your voice. I've opened the switch in Settings." };
  return {
    set: true,
    reply: "Okay, I'll work without asking and tell you what I'm doing. I still ask before anything risky, such as sending or deleting. Say “Ask me first again” to change it back, or “Ember, stop” to stop me.",
  };
}
