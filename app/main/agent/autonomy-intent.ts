/**
 * The approval mode by voice or typed words (owner decision of 2026-11-12, PLAN.md §10 "Settled" (5); "Work without
 * asking" and "ask me first again" of 2026-11-02 kept, mapped onto the modes): naming a mode ("switch to Autopilot",
 * "Assisted mode", "go back to Interactive", "turn Autopilot off"), "work without asking" (Interactive at least) and
 * "ask me first again" (below Interactive, every card's agreement withdrawn). Answered in the host, as status.ts's
 * questions are, with no Copilot turn and no conductor tool: the model can neither hear of it as a tool nor change the
 * mode.
 *
 * The spoken-answer rule decides who may: a switch to a mode that asks less only by voice, from anyone heard while
 * Voice Match is off and only from the owner's verified voice while it is on, never over Ember's voice nor in it, and
 * only once that mode's card has been agreed to in Home (otherwise Home opens at the choice or its card and Ember says
 * why); typed words never ask less, as they never approve. A switch to a mode that asks more works for anyone, typed or
 * spoken. Every reply is built here, in Ember's words. Pure, so it is unit-tested without Electron.
 */

import { modeRank, type ApprovalMode, type ModeInForce } from "../../shared/approvals";

/** What may come before: the name, "hey Ember", "ok", "please". */
const LEAD = String.raw`(?:(?:hey|ok|okay|so|right|now)[,\s]+)?(?:ember[,\s]+)?(?:please[,\s]+)?(?:(?:can|could|will|would) you[,\s]+)?(?:please[,\s]+)?`;
/** What may come after: "please", "from now on", the name again. */
const TAIL = String.raw`(?:[,\s]+(?:please|from now on|for now|now|thanks|thank you|ember))*`;

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

/** A mode's name as people say it and the recognizer writes it ("auto pilot", "auto-pilot"). */
const NAME = String.raw`(?:the )?(interactive|assisted|auto[- ]?pilot)(?: mode)?`;
/** Naming a mode to switch to it. A bare name alone is no request: it needs a verb, or "mode" after it. */
const TO = [
  String.raw`(?:switch|change|go|move|get|come|put yourself|set yourself)(?: back| over| right)? (?:to|into|in|on) ${NAME}`,
  String.raw`(?:go )?back to ${NAME}`,
  String.raw`(?:use|start|try|choose|pick|enable|turn on|switch on|put on|engage) ${NAME}`,
  String.raw`(?:the )?(interactive|assisted|auto[- ]?pilot) mode(?: on)?`,
  String.raw`(?:the )?(interactive|assisted|auto[- ]?pilot)(?: mode)? on`,
];
/** Turning a mode off. */
const OFF_MODE = [
  String.raw`(?:turn|switch|take) off ${NAME}`,
  String.raw`(?:turn|switch|take) ${NAME} off`,
  String.raw`(?:stop|leave|exit|end|quit|disable|cancel|come out of|get out of) ${NAME}`,
  String.raw`(?:the )?(interactive|assisted|auto[- ]?pilot)(?: mode)? off`,
  String.raw`no more ${NAME}`,
];

const whole = (parts: string[]) => new RegExp(String.raw`^${LEAD}(?:${parts.join("|")})${TAIL}$`, "i");
const ON_RE = whole(ON);
const OFF_RE = whole(OFF);
const TO_RE = whole(TO);
const OFF_MODE_RE = whole(OFF_MODE);

const norm = (text: string) => text.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/[\s?!.…]+$/u, "").replace(/\s+/g, " ");

/** The mode a regexp's groups named (only one of them took part). */
const named = (m: RegExpExecArray): ApprovalMode => {
  const word = m.slice(1).find(g => g !== undefined) ?? "";
  return word.startsWith("auto") ? "autopilot" : (word as ApprovalMode);
};

/**
 * What the words ask of the mode: Interactive at least ("work without asking"), below Interactive ("ask me first
 * again"), a mode by its name, or a mode off.
 */
export type ModeIntent =
  | { kind: "without-asking" }
  | { kind: "ask-first" }
  | { kind: "to"; mode: ApprovalMode }
  | { kind: "off"; mode: ApprovalMode };

/** Does the whole of `text` ask for a mode? Null: no; the conversation's. */
export function modeIntent(text: string): ModeIntent | null {
  const t = norm(text);
  if (!t || t.length > 80) return null;
  if (OFF_RE.test(t)) return { kind: "ask-first" };
  let m = OFF_MODE_RE.exec(t);
  if (m) return { kind: "off", mode: named(m) };
  m = TO_RE.exec(t);
  if (m) return { kind: "to", mode: named(m) };
  return ON_RE.test(t) ? { kind: "without-asking" } : null;
}

/** What the host knows of the mode when the intent comes (main builds it from the settings and the policy, with its Voice Match switch). */
export interface ModeIntentState {
  /** The mode in force now. */
  inForce: ModeInForce;
  /** The modes whose card is agreed to as it reads now. */
  agreed: readonly ApprovalMode[];
  /** The administrator keeps Ember below Interactive (autonomyPermitted false). */
  managed: boolean;
  /** The highest mode the administrator allows (`approvals.maxMode`); null without a cap. */
  cap: ApprovalMode | null;
  /** The administrator turned Assisted's check off (`features.aiReview: false`): Assisted is in force as Interactive. */
  checkOff: boolean;
  /**
   * Voice Match's switch: off (its default: anyone heard), on and in use, or on but not ready (never taught, or its
   * model isn't in): then nobody's voice can ask less (fail closed).
   */
  voiceMatch: "off" | "on" | "unready";
}

/** How the words came. */
export interface ModeIntentHeard {
  /** Heard (false: typed, or a suggestion pressed). */
  spoken: boolean;
  /** Voice Match verified it as the owner's voice. */
  verified: boolean;
  /** Voice Match matched the owner's voice, but on too little of it to vouch for it (match.ts APPROVAL_MIN_SECONDS). */
  short: boolean;
  /** Heard over Ember's own voice, or since it last spoke (VoiceService.selfSpokeSince): never what asks less. */
  overEmber: boolean;
}

/**
 * What to do: choose `set` (a mode, or "asking": every card's agreement withdrawn), open Home's choice at a mode's row
 * or its card (`open`), and say `reply`. `set` is done only as the plan says, so the host never asks less on its own.
 */
export interface ModeIntentPlan { set?: ApprovalMode | "asking"; open?: { mode: ApprovalMode; card: boolean }; reply: string }

/** Said instead of the plan's reply when the change couldn't be saved or recorded (a mode that asks less is then undone). */
export const AUTONOMY_NOT_SAVED = "I couldn't save or record that change, so I'll keep asking you first.";

/** The modes as Ember names them. */
export const MODE_NAME: Readonly<Record<ApprovalMode, string>> = { interactive: "Interactive", assisted: "Assisted", autopilot: "Autopilot" };

/** Said once a mode that asks less is in force (each claim is what that mode does: PLAN.md §2 "Approvals"). */
const NOW_IN: Readonly<Record<ApprovalMode, string>> = {
  interactive: "Okay, I'll work without asking and tell you what I'm doing. I still ask before anything risky, such as sending or deleting. Say “Ask me first again” to change it back, or “Ember, stop” to stop me.",
  assisted: "Okay, I'm in Assisted: before I ask about a step, a lighter model checks it against what you asked for, and a step it matches goes ahead, announced. It can be wrong. Say “Go back to Interactive” to change it back, or “Ember, stop” to stop me.",
  autopilot: "Okay, I'm in Autopilot: I won't ask before steps, risky ones included, and I'll tell you what I'm doing. I still ask about a few commands, such as one that would read secrets. Say “Go back to Interactive” to change it back, or “Ember, stop” to stop me.",
};
/** Said once a mode that asks more is in force. */
const BACK_IN: Readonly<Record<ApprovalMode, string>> = {
  interactive: "Okay, I'm back in Interactive: I work without asking before ordinary steps, and I ask before anything risky.",
  assisted: "Okay, I'm in Assisted: I ask before anything risky that a lighter model doesn't find in what you asked for.",
  autopilot: "Okay, I'm in Autopilot.",
};

/** How Ember works now, as a clause. */
const workingNow = (m: ModeInForce) => (m === "asking" ? "I ask you before every step" : `I'm in ${MODE_NAME[m]}`);

/** The mode a switch to `to` (asking more) lands in: the highest at or below it whose card is agreed to. */
function landing(to: ApprovalMode, s: ModeIntentState): ModeInForce {
  for (let rank = modeRank(to); rank >= 1; rank--) {
    const m = (["interactive", "assisted", "autopilot"] as const)[rank - 1];
    if (m === "assisted" && s.checkOff) continue;
    if (s.agreed.includes(m)) return m;
  }
  return "asking";
}

/** The plan for `intent` (pure: the host carries it out). */
export function planModeIntent(intent: ModeIntent, s: ModeIntentState, heard: ModeIntentHeard): ModeIntentPlan {
  let to: ApprovalMode | "asking";
  if (intent.kind === "ask-first") to = "asking";
  else if (intent.kind === "without-asking") {
    if (s.inForce === "interactive") return { reply: "I'm already working without asking. I still ask before anything risky, and “Ember, stop” stops me." };
    if (s.inForce !== "asking") return { reply: `I'm already in ${MODE_NAME[s.inForce]}, which asks even less. “Ember, stop” stops me.` };
    to = "interactive";
  } else if (intent.kind === "off") {
    if (s.inForce !== intent.mode) return { reply: s.inForce === "asking" ? "I already ask you first." : `${MODE_NAME[intent.mode]} isn't on: ${workingNow(s.inForce)}.` };
    to = intent.mode === "interactive" ? "asking" : "interactive";
  } else to = intent.mode;

  if (to === "asking") {
    return s.inForce === "asking" ? { reply: "I already ask you first." } : { set: "asking", reply: "Okay, I'll ask you first again. To change it back, choose Interactive in Settings." };
  }
  const name = MODE_NAME[to];
  if (s.inForce === to) return { reply: `I'm already in ${name}.` };

  // A mode that asks more: anyone, typed or spoken. Where its card isn't agreed to, Ember lands lower and says so.
  if (modeRank(to) < modeRank(s.inForce)) {
    const lands = landing(to, s);
    if (lands === to) return { set: to, reply: BACK_IN[to] };
    const why = to === "assisted" && s.checkOff ? "your organisation has turned Assisted's check off" : `${name}'s card isn't agreed to yet`;
    return {
      set: to, open: { mode: to, card: !(to === "assisted" && s.checkOff) },
      reply: `Okay, but ${why}, so until then ${lands === "asking" ? "I'll ask you before every step" : `I'm in ${MODE_NAME[lands]}`}. I've opened it in Settings.`,
    };
  }

  // A mode that asks less: the organisation's limits first, then its card, then who said it.
  if (s.managed) return { reply: "Your organisation doesn't allow that, so I'll keep asking first." };
  if (s.cap && modeRank(to) > modeRank(s.cap)) return { reply: `Your organisation allows ${MODE_NAME[s.cap]} at most, so I can't switch to ${name}.` };
  if (to === "assisted" && s.checkOff) return { reply: "Your organisation has turned Assisted's check off, so I can't switch to Assisted." };
  if (!s.agreed.includes(to)) {
    return {
      open: { mode: to, card: true },
      reply: to === "interactive" ? "First have a look at what that means: I've opened it in Settings. Agree there, and I'll work without asking." : `First have a look at what ${name} means: I've opened its card in Settings. Agree there, and I'll switch to it.`,
    };
  }
  // Typed words never ask less, as they never answer a question (CLAUDE.md "Policy decides, not the model").
  if (!heard.spoken) return { open: { mode: to, card: false }, reply: `I switch to a mode that asks less only when you say it or choose it in Settings. I've opened it there: choose ${name} to switch.` };
  if (heard.overEmber) return { reply: "I was still speaking, so I didn't take that. Say it again now that I've stopped." };
  if (s.voiceMatch === "unready") return { open: { mode: to, card: false }, reply: `Voice Match is on but isn't ready yet, so I can't switch by voice. I've opened it in Settings: choose ${name} there.` };
  if (s.voiceMatch === "on" && !heard.verified) {
    if (heard.short) return { reply: `Say a little more so I can be sure it's you: “Ember, please ${intent.kind === "without-asking" ? "work without asking from now on" : `switch to ${name}`}.”` };
    return { reply: "That didn't sound like you, so I didn't switch." };
  }
  return { set: to, reply: NOW_IN[to] };
}
