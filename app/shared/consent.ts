import type { TargetId } from "./targets";

/**
 * Bumped when what Ember does with the screen or data changes: everyone is asked again. 2 (2026-11-03): Voice Match keeps
 * refining the voiceprint from the owner's requests, and the words the user corrects are kept (docs/ASSISTANT.md §7).
 * 3: Listen once can open the microphone for a single request while wake listening is off.
 * 4: Project work sends the text files the user selects to the connected model.
 * 6 (2026-11-05): once called, Ember keeps listening through a conversation, and what it hears goes to Copilot as text
 * without its name; Voice Match no longer decides who is heard.
 * 7 (2026-11-06): Home's “Keep my recent conversation” (off by default) can keep the latest messages on this computer
 * across restarts; "Before Ember starts" says so.
 * 8 (2026-11-12): while a question is up, anyone near the computer can answer it by voice, with Voice Match off (its
 * default), and for a few seconds after Ember asks it listens for that answer without its name (the answer window);
 * with Voice Match on, only the owner's voice can say yes (owner decision of 2026-11-12, PLAN.md §2 "Approvals"). On
 * Windows the output's level is read while a question is up or a task is at work as well as in a conversation, which
 * the “Hey Ember” card says (owner's report of 2026-11-12).
 * 9 (2026-11-13): first run's one agreement turns on, each with its own switch and its own card's text, commands on
 * this computer, memory, “Hey Ember” with spoken replies, screenshots for tasks and Interactive (owner decision of
 * 2026-11-12, app/shared/first-run.ts); someone who agreed before keeps their settings and is asked about Interactive.
 * 10 (2026-11-13): the vault keeps something new on this computer: logins, cards and contact details the user gives
 * in Ember's Secure Form, sealed with the keyring, which only Autopilot fills in and no model sees (owner decision of
 * 2026-11-12, app/main/vault/).
 * 12: Interactive now asks before dangerous commands even when the user asked for them.
 * 13: explicit Save projects keeps an encrypted project/session checkpoint, with no automatic work resumption.
 * 14: requested coding work copies a chosen project folder, may send files/output to the model, and offers explicit
 * full-file review exports; connection-scoped grants/reviews and unverified private-copy cleanup are disclosed.
 * 11 (2026-11-14): "Before Ember starts" no longer says Ember always asks before anything hard to undo: it says what
 * asks (a risky step in an app; a dangerous command or code Ember can't read, unless the user asked for exactly that
 * command and it does no more than commands-card.ts EXACT_ONLY says, shown first with a few seconds to stop it), that a
 * command Ember doesn't know runs, announced (the owner's decision of 2026-11-14), and that Assisted and Autopilot ask
 * less (PLAN.md §10 Settled 28; first-run-r10-7, -r10-8, accessibility-c11-1, r11-copy-x11-1, -x11-3).
 */
export const CONSENT_VERSION = 14;

/**
 * What each bump of CONSENT_VERSION changed, in Ember's words, for someone who agreed to an earlier version: first run
 * shows the lines since the version they agreed to above the consent (first-run-4). Each says no more than "Before
 * Ember starts" says (home-welcome.test.ts pairs every line with the full text's words). A bump adds its line here.
 */
export const CONSENT_CHANGES: Readonly<Record<number, string>> = {
  14: "When you ask for coding work, I copy the project folder you chose and may send requested files and command output to your model, leaving the original unchanged. Exports keep all captured files, including unchanged files, until you remove them. Private copies I can't verify as removed may remain and block new coding work.",
  13: "If you choose Save projects, I encrypt project names, goals and session outcomes on this computer until you choose Forget saved projects or Forget everything. Opening a checkpoint never resumes work.",
  2: "If you teach me your voice, I keep refining your voiceprint from requests I'm sure are yours, and I keep the words you correct.",
  3: "Listen once can open the microphone for one request while “Hey Ember” is off.",
  4: "In Project work, Send selected files shares your request and the contents of those files with the connected model.",
  5: "If you save a project workspace, I encrypt its selected paths and last completed request and answer on this computer.",
  6: "Once you call me, I keep listening through the conversation, and what I hear there is sent as text, without my name.",
  7: "If you turn on “Keep my recent conversation”, its latest messages stay on this computer after I restart.",
  8: "While one of my questions is up, anyone near the computer can answer it by voice, and for a few seconds after I ask, I listen for that answer without my name. With Voice Match on, only your voice can say yes.",
  9: "If you haven't agreed to Interactive yet, agreeing now turns it on unless you switch it off here or your organisation keeps it off, so I don't ask before ordinary steps in an app. Your other settings stay as they are.",
  10: "If you give me a login, a card or contact details in my Secure Form, I keep them in a vault on this computer, locked with your computer's keyring, until you forget them. Only Autopilot fills them in, and the AI model never sees them.",
  12: "In Interactive, I ask before a dangerous command even when you asked for it.",
  11: "I say plainly what I ask before: anything risky in an app, and a command I know is dangerous or code I can't read, even if you asked for it. A command I don't know runs, and I tell you, and Assisted and Autopilot, if you choose them later, ask less.",
};

/** The changes since the version the user agreed to (`agreed`), oldest first: none for a first agreement (0) or a current one. */
export function consentChangesSince(agreed: number): string[] {
  if (agreed <= 0) return [];
  return Object.entries(CONSENT_CHANGES).filter(([v]) => Number(v) > agreed && Number(v) <= CONSENT_VERSION).sort(([a], [b]) => Number(a) - Number(b)).map(([, line]) => line);
}

/**
 * The versions of the first-use consent cards for WSL, SSH (per host) and commands (per target), recorded apart from
 * CONSENT_VERSION (L1: the global consent stays true for everything Ember does without them). Bumping one asks that
 * card again, and nothing else. `provider`: the user's own model provider (Home's Copilot section), agreed to per
 * endpoint host (settings `provider.consent.host`). `memory` 4 (2026-11-07): its note says the profile (what to call
 * the user, how they like answers) goes with every request, and that the idle tidy sends up to 40 facts up to 6 times
 * a day (memory-5, memory-9). The approval modes' cards (app/shared/approvals.ts MODE_CARD; owner decision of
 * 2026-11-12): `autonomy` is Interactive's, 3 since it replaced Work without asking's card (2), so an agreement to
 * that one is no agreement to this, and 4 (2026-11-14) since it says that a dangerous command the user asked for exactly
 * is shown first with a few seconds to stop it, not asked about (accessibility-c11-1); `assisted` and `autopilot` are those modes' own. `assisted` 2 (2026-11-13): its
 * card names everything the check is sent, a dialog's words, the text a step would replace, a cell's formula, where
 * carried text came from and a command's computer, shell and folder among them (modes-x9p-4). `autopilot` 2
 * (2026-11-13): its card says Ember fills what the user saved in the vault into password, card and sign-in fields,
 * where 1 said it never types them, so an agreement to 1 is asked again before Autopilot is in force; the same 2 names
 * every command it still asks about, among them one the user may have ruled out: by their own words for the task, or
 * as what may be a command they said no to in it (integ-x-6). `extensions` 4 (2026-11-13): its cards say that in
 * Autopilot Ember uses a tool that changes or sends without asking and says so, where 3 said it always asked
 * (integrations-r10-1). The owner's decision of 2026-11-14 (only dangerous commands ask; Autopilot asks nothing)
 * rewrote four cards: `commands` 2 says in one text what each mode does with a dangerous command and that Autopilot
 * keeps a secrets command's output from the model; `autonomy` 5 says commands Ember doesn't know run and names what is
 * dangerous; `assisted` 3 drops the commands its check "never clears" that it now may; `autopilot` 3 lists no question
 * it no longer puts and says what it does instead (output withheld, Stop's reach named, the user's no refused, the
 * organisation's and the user's own switch still asked); `autopilot` 4 also names the two other places every command
 * still asks there, a distro Podman uses and Project work, which 3 left out (integ-x-2). `extensions` 5 (2026-11-14):
 * its cards say that in Assisted a tool that changes or sends goes ahead, announced, when Assisted's check finds the
 * call in what the user asked, where 4 said only Autopilot went ahead, and `assisted` 4 names what its check is sent
 * of such a call: the extension's tool and what it is given, never the tool's description (integrations-r12-1).
 * `commands` 3 (2026-11-14): its card for a computer whose commands run as root says Assisted's check may clear
 * one the request was about, where 2 said every such command asks there (tasks-approvals-r12-1). `assisted` 5: its
 * card says the check may clear a command that runs as root or an administrator, which 4 left out (integ-x-4).
 * `autonomy` 6 and `commands` 4: their cards say Interactive asks before dangerous commands the user requested.
 */
export const FEATURE_CONSENT_VERSION = { wsl: 1, ssh: 1, commands: 4, memory: 4, routines: 1, extensions: 5, autonomy: 6, provider: 1, updates: 1, assisted: 5, autopilot: 4 } as const;

/**
 * A first-use consent card (§8.4): its exact text, and a hash of it that the yes must carry back. Shown in Ember's
 * prompt window; confirm.ts takes it as a question's panel.
 */
export interface ConsentPanel {
  feature: "commands" | "wsl" | "ssh";
  target: TargetId;
  targetLabel: string;
  title: string;
  body: string[];
  yes: string;
  no: string;
  /** sha256Hex of title + "\n" + body.join("\n"). */
  sha256: string;
}
