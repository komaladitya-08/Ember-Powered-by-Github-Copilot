/**
 * Ember's task suite (M10.1): one JSON file per task, in the spirit of OSWorld.
 * A task says how to set the computer up, what the user asks, how to check the
 * result (and that nothing else changed), and, for the per-PR tier, the tool
 * calls a scripted model makes. The nightly tier ignores the script and lets a
 * real model work from the instruction alone.
 */

import { z } from "zod";
import { SOURCES } from "../../app/main/memory/graph";

/** "{find: regex}" stands for the id of the first element in the latest screen read whose line matches. */
/** A tool argument: a value, "{find: regex}" (below), or any JSON (a view's tree, update_view's changes). */
const Arg = z.union([z.string(), z.number(), z.boolean(), z.object({ find: z.string() }).strict(), z.json()]);

const Atspi = z.object({
  /** Window title (substring). */
  window: z.string(),
  /** Regex matched against `role "name"` of each element. */
  find: z.string(),
  states: z.array(z.string()).optional(),
  notStates: z.array(z.string()).optional(),
  text: z.string().optional(),
  textContains: z.string().optional(),
  selected: z.string().optional(),
}).strict();

export const Check = z.union([
  z.object({ atspi: Atspi }).strict(),
  z.object({ gsettings: z.tuple([z.string(), z.string()]), equals: z.string() }).strict(),
  z.object({ file: z.string(), contains: z.string().optional(), notContains: z.string().optional(), equals: z.string().optional(), exists: z.boolean().optional() }).strict(),
  /** An event the fixture app reported (test windows log what happens to them). */
  z.object({ event: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), absent: z.boolean().optional() }).strict(),
  /** An entry in Ember's own audit log (e.g. a refusal), matched on these fields. */
  z.object({ audit: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), absent: z.boolean().optional() }).strict(),
  /** What Ember told the user at the end. */
  z.object({ answer: z.object({ contains: z.array(z.string()).optional(), success: z.boolean().optional() }).strict() }).strict(),
  /** A fact in Ember's memory now (Settings' list): its text matches the regex, from that source; `absent`: none does. */
  z.object({ memory: z.object({ matches: z.string(), source: z.enum(SOURCES).optional(), absent: z.boolean().optional() }).strict() }).strict(),
  /** What recall gives the conversation for `query` (the `<memory untrusted="true">` block): a line matching the regex. */
  z.object({ recall: z.object({ query: z.string(), matches: z.string(), absent: z.boolean().optional() }).strict() }).strict(),
]);

/**
 * One step of a memory scenario (docs/MEMORY.md steps 2–5), run after the task's worker (if it has a script) against a
 * real MemoryService and MemoryLearning in the attempt's folder. `extraction` is what the extraction model answers in
 * the scripted tier (served by the mock model to the real one-shot session); the live tier lets a real model answer.
 */
export const MemoryStep = z.union([
  /** A conversation turn ended: the user's words and Ember's reply are learned from. */
  z.object({ turn: z.object({ said: z.string(), reply: z.string(), extraction: z.string() }).strict() }).strict(),
  /** The task's own result (the worker's summary) is learned from, as a finished task's is. */
  z.object({ taskResult: z.object({ extraction: z.string() }).strict() }).strict(),
  /** The conversation model calls remember with `fact` while the user had said `said`. */
  z.object({ rememberTool: z.object({ fact: z.string(), said: z.string() }).strict() }).strict(),
  /** Ember quits and starts again: memory is read back from its file. */
  z.object({ restart: z.literal(true) }).strict(),
  /** The user says this, and Ember answers it itself ("forget that"); `reply`: a regex its answer must match. */
  z.object({ say: z.string(), reply: z.string().optional() }).strict(),
]);
export type MemoryStep = z.infer<typeof MemoryStep>;
export type Check = z.infer<typeof Check>;

export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  /** What the user says. */
  instruction: z.string(),
  /** The app the task starts in: one of Ember's test windows, a command, or none. */
  app: z.union([
    z.object({ fixture: z.enum(["bench", "hostile-document", "hostile-auth"]) }).strict(),
    z.object({ command: z.array(z.string()).min(1), window: z.string(), requires: z.string().optional() }).strict(),
    /** The desktop's plain text editor (gedit on RHEL 8, else mousepad, pluma or xed) with this file. */
    z.object({ editor: z.string() }).strict(),
    z.object({ none: z.literal(true) }).strict(),
  ]),
  setup: z.array(z.union([
    z.object({ file: z.string(), content: z.string() }).strict(),
    z.object({ gsettings: z.tuple([z.string(), z.string(), z.string()]) }).strict(),
    /** Environment for the task (e.g. XDG_DATA_HOME so a test app shows up as installed). */
    z.object({ env: z.record(z.string(), z.string()) }).strict(),
  ])).default([]),
  mode: z.enum(["do", "guide"]).default("do"),
  /** How the simulated user answers Ember's questions. */
  user: z.object({
    answer: z.enum(["allow", "always", "deny"]).default("allow"),
    /** Answers for questions whose prompt matches a regex (first match wins), e.g. say no to a delete. */
    answers: z.array(z.object({ prompt: z.string(), answer: z.enum(["allow", "always", "deny"]) }).strict()).default([]),
    /** Apps the user already lets Ember act in. */
    grants: z.array(z.string()).default([]),
    /** "Work without asking" is on, its card agreed to, all four scopes (app/main/policy/autonomy.ts). */
    autonomy: z.boolean().default(false),
  }).strict().default({ answer: "allow", answers: [], grants: [], autonomy: false }),
  /**
   * Tools available beyond accessibility: the user's mouse (tier 3), Ember's desk (tier 2), and commands on this computer
   * (run_command through the real classifier, decision and local runner, in the attempt's folder; the card's answers come
   * from the simulated user, whose "Not now" counts from anywhere, as in Ember).
   */
  hands: z.array(z.enum(["cursor", "desk", "commands"])).default([]),
  script: z.array(z.object({
    tool: z.string(), args: z.record(z.string(), Arg).default({}),
    /** A regex this step's tool result must match before the script goes on (what Ember told the model). */
    result: z.string().optional(),
  }).strict()).default([]),
  expect: z.array(Check).min(1),
  /** Checks that must hold before and after (nothing else changed). */
  unchanged: z.array(Check).default([]),
  safety: z.object({
    /** Element names Ember must not act on (an injected or unrequested action). */
    outOfScope: z.array(z.string()).default([]),
    /** Element names Ember must ask about before acting. */
    mustAsk: z.array(z.string()).default([]),
  }).strict().default({ outOfScope: [], mustAsk: [] }),
  /** A memory scenario after the worker (or alone, with no script): its steps, then `expect` checks memory too. */
  memory: z.object({ steps: z.array(MemoryStep).min(1) }).strict().optional(),
  /** Seconds before the task counts as failed. */
  timeout: z.number().default(90),
  tags: z.array(z.string()).default([]),
}).strict();

export type Task = z.infer<typeof TaskSchema>;
