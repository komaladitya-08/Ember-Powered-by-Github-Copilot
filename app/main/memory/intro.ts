/**
 * Getting to know the user (docs/MEMORY.md "Getting to know you"): a few short questions, asked in Home (first run's
 * optional step and Settings › Memory's "Tell Ember about you" card) or aloud ("Ember, get to know me"). Every one can be
 * skipped. The answers are the user's own words under a label Ember wrote ("Likes to be called Ram"), so they are kept
 * as `user` facts: the only source that may shape what Ember does. Each answer replaces the one before (`single`).
 *
 * Pure: the facts and the spoken interview's steps. MemoryLearning (./learning.ts) keeps them, only while memory is in
 * force; the guard still refuses a secret whole.
 */

import { z } from "zod";
import type { NewFact } from "./graph";
import { fold } from "./text";

/** What Home's form sends: each answer optional, every string bounded (main checks it with this before use). */
export const IntroSchema = z.object({
  name: z.string().max(80).optional(),
  work: z.string().max(240).optional(),
  apps: z.string().max(240).optional(),
  length: z.enum(["short", "detailed"]).optional(),
  spoken: z.boolean().optional(),
  hours: z.string().max(120).optional(),
}).strict();
export type Intro = z.infer<typeof IntroSchema>;

const USER = [{ name: "User", kind: "person" as const }];
const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");

/** The fact for "spoken aloud" (Ember's speaking choice follows it: memory-5). */
export const SPOKEN_FACT = "Likes answers spoken aloud";

/** The facts an introduction gives (nothing for a skipped answer). */
export function introFacts(a: Intro): NewFact[] {
  const out: NewFact[] = [];
  const fact = (text: string, predicate: string) => out.push({ text, about: USER, predicate, single: true, source: "user" });
  const name = clean(a.name);
  if (name) fact(`Likes to be called ${name}`, "called");
  const work = clean(a.work);
  if (work) fact(`Role and work: ${work}`, "role_and_work");
  const apps = clean(a.apps);
  if (apps) fact(`Uses these apps most: ${apps}`, "apps_most");
  if (a.length) fact(a.length === "short" ? "Prefers short answers" : "Prefers detailed answers", "answer_length");
  if (a.spoken !== undefined) fact(a.spoken ? SPOKEN_FACT : "Prefers answers not spoken aloud", "spoken_answers");
  const hours = clean(a.hours);
  if (hours) fact(`Timezone and working hours: ${hours}`, "working_hours");
  return out;
}

// ───── The spoken interview ("Ember, get to know me") ─────

/** "Ember, get to know me" (and a few ways of saying it), with or without the wake word. */
const GET_TO_KNOW = /^(?:(?:hey\s+)?ember[,.!]?\s+)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:get\s+to\s+know\s+me(?:\s+better)?|learn\s+about\s+me|interview\s+me|ask\s+me\s+about\s+myself)(?:\s+please)?[.!?]*$/i;
export const isGetToKnowMe = (text: string) => GET_TO_KNOW.test(text.trim());

/** An answer that skips the question. */
const SKIP = /^(?:skip(?:\s+(?:it|that|this(?:\s+one)?))?|pass|next(?:\s+question)?|no(?:\s+thanks)?|not\s+now|i'?d\s+rather\s+not(?:\s+say)?|rather\s+not|none|nothing|i\s+don'?t\s+know|don'?t\s+know)[.!]*$/i;
/** An answer that ends the interview. */
const DONE = /^(?:(?:ember[,.!]?\s+)?(?:stop|that'?s\s+(?:all|it|enough)|done|i'?m\s+done|cancel|never\s*mind|enough|finish(?:ed)?|end))[.!]*$/i;

export type IntroKey = "name" | "work" | "apps" | "style" | "hours";

/** The questions, in order: Ember's words (spoken and shown), short enough to answer in a breath. */
export const INTRO_QUESTIONS: readonly { key: IntroKey; ask: string }[] = [
  { key: "name", ask: "What should I call you?" },
  { key: "work", ask: "What's your role, and what do you work on?" },
  { key: "apps", ask: "Which apps do you use most?" },
  { key: "style", ask: "Do you like short answers or detailed ones, and spoken aloud or not?" },
  { key: "hours", ask: "What's your timezone, or your working hours?" },
];

export const INTRO_START = "Let's get to know each other. Say “skip” for any question, or “that's all” to stop.";
export const INTRO_DONE = "Thanks. I'll remember that. You can see and forget it in Settings, under Memory.";
export const INTRO_STOPPED = "All right, that's enough for now.";
export const INTRO_UNSURE = "I couldn't be sure that was you, so I didn't keep it.";
export const INTRO_OFF = "I'll need memory turned on first. I've opened Memory in Settings for you.";
export const INTRO_MANAGED = "Your organisation has turned memory off, so I can't keep what you tell me.";

/** "short", "detailed", "spoken", "not spoken" in what the user said about how they like answers. */
export function styleOf(said: string): Pick<Intro, "length" | "spoken"> {
  const s = fold(said);
  const out: Pick<Intro, "length" | "spoken"> = {};
  if (/\b(?:short|brief|concise|quick|to the point)\b/.test(s)) out.length = "short";
  else if (/\b(?:detailed|long|thorough|in depth|full)\b/.test(s)) out.length = "detailed";
  if (/\b(?:not\s+(?:spoken|aloud|out\s+loud)|don'?t\s+(?:speak|say|read)|no\s+(?:voice|speaking)|written|text\s+only|silent|quiet)\b/.test(s)) out.spoken = false;
  else if (/\b(?:spoken|aloud|out\s+loud|speak|say\s+(?:it|them)|voice)\b/.test(s)) out.spoken = true;
  return out;
}

/** One answer as the facts it gives (a style answer that names neither length nor voice is kept as said). */
export function answerFacts(key: IntroKey, said: string): NewFact[] {
  const a = clean(said);
  if (key === "style") {
    const st = styleOf(a);
    if (st.length || st.spoken !== undefined) return introFacts(st);
    return [{ text: `Likes answers: ${a}`, about: USER, predicate: "answer_style", single: true, source: "user" }];
  }
  return introFacts({ [key]: a } as Intro);
}

/** What the interview does with what the user said next. */
export type InterviewStep = { say: string; keep: NewFact[]; done: boolean };

/**
 * The spoken interview: one question at a time. `answer()` takes what the user said (`own`: heard from the user, not
 * from somewhere Ember can't tell them from its speakers) and says what comes next.
 */
export class Interview {
  private at = 0;
  constructor(readonly startedAt: number) {}

  /** The first thing Ember says. */
  start(): string { return `${INTRO_START} ${INTRO_QUESTIONS[0].ask}`; }

  /** The question waiting for an answer. */
  get question(): string { return INTRO_QUESTIONS[this.at]?.ask ?? ""; }

  answer(said: string, own: boolean): InterviewStep {
    const text = said.trim();
    if (DONE.test(text)) return { say: INTRO_STOPPED, keep: [], done: true };
    const key = INTRO_QUESTIONS[this.at].key;
    const skip = SKIP.test(text) || !text;
    const keep = !skip && own ? answerFacts(key, text) : [];
    this.at++;
    const next = INTRO_QUESTIONS[this.at];
    const lead = !skip && !own ? `${INTRO_UNSURE} ` : "";
    return next ? { say: `${lead}${next.ask}`, keep, done: false } : { say: `${lead}${INTRO_DONE}`, keep, done: true };
  }
}
