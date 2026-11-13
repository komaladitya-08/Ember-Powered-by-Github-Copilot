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
 */
export const CONSENT_VERSION = 8;

/**
 * What each bump of CONSENT_VERSION changed, in Ember's words, for someone who agreed to an earlier version: first run
 * shows the lines since the version they agreed to above the consent (first-run-4). Each says no more than "Before
 * Ember starts" says (home-welcome.test.ts pairs every line with the full text's words). A bump adds its line here.
 */
export const CONSENT_CHANGES: Readonly<Record<number, string>> = {
  2: "If you teach me your voice, I keep refining your voiceprint from requests I'm sure are yours, and I keep the words you correct.",
  3: "Listen once can open the microphone for one request while “Hey Ember” is off.",
  4: "In Project work, Send selected files shares your request and the contents of those files with the connected model.",
  5: "If you save a project workspace, I encrypt its selected paths and last completed request and answer on this computer.",
  6: "Once you call me, I keep listening through the conversation, and what I hear there is sent as text, without my name.",
  7: "If you turn on “Keep my recent conversation”, its latest messages stay on this computer after I restart.",
  8: "While one of my questions is up, anyone near the computer can answer it by voice, and for a few seconds after I ask, I listen for that answer without my name. With Voice Match on, only your voice can say yes.",
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
 * that one is no agreement to this; `assisted` and `autopilot` are those modes' own. `assisted` 2 (2026-11-13): its
 * card names everything the check is sent, a dialog's words, the text a step would replace, a cell's formula, where
 * carried text came from and a command's computer, shell and folder among them (modes-x9p-4).
 */
export const FEATURE_CONSENT_VERSION = { wsl: 1, ssh: 1, commands: 1, memory: 4, routines: 1, extensions: 3, autonomy: 3, provider: 1, updates: 1, assisted: 2, autopilot: 1 } as const;

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
