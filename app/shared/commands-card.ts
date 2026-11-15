/**
 * The commands card's lines that say when Ember asks (§8.4.3), shared by main (targets/consent.ts, whose text the
 * agreement's hash covers) and the prompt window (renderer/prompt/copy.ts), so the two can't drift. One text for every
 * approval mode, true in each and as root, to the owner's decision of 2026-11-14 (briefs/owner-2026-11-14.md; PLAN.md
 * §10 Settled 28, r10-modes-copy-y10-1): an ordinary command, and one Ember has no row for, runs; a dangerous one, and
 * code Ember can't read, asks in Interactive unless the user asked for exactly that one and it does no more than
 * EXACT_ONLY says, goes to Assisted's check, and runs announced in Autopilot, where what a secrets command prints is
 * kept from the model; the user's no, the organisation's policy and the user's own "Ask me before every command" hold
 * in every mode (commands/decide.ts, review.ts notReviewable, autopilot.ts autopilotAsks). Change a line only with a
 * bump of `FEATURE_CONSENT_VERSION.commands`.
 */

/**
 * What a dangerous command the user asked for exactly may do and still go ahead in Interactive, shown first with its
 * Stop countdown (decideCommand's rule 10, intent.ts matchIntent): the dangerous classes but ALWAYS_ASK's (secrets,
 * download-and-run or outliving Stop, code Ember can't read), which ask whatever the words (r11-copy-x11-1). Every card
 * and line that names the exception says it in these words; asking-words.test.ts derives them from ALWAYS_ASK.
 */
export const EXACT_ONLY = "only deletes or overwrites data, publishes something or changes the system";
/** The classes EXACT_ONLY names, in its order (deletes covers a deletion in source control or a remote service too). */
export const EXACT_ONLY_CLASSES = ["destroy", "remote-delete", "publish", "system"] as const;

/**
 * Ember runs as root or an elevated administrator there: every command asks in Interactive (decide.ts), Assisted's
 * check may let one the request was about go ahead (review.ts notReviewable: tasks-approvals-r12-1), and Autopilot
 * announces each (r11-copy-x11-2).
 */
export const COMMANDS_CARD_PRIVILEGED = "Commands here run as the administrator, so in Interactive Ember asks before every one, even one you asked for exactly. In Assisted, each goes ahead when a check finds it in what you asked for, and asks otherwise. In Autopilot, each runs after a few seconds to stop it.";

/** A distro Podman uses: every command asks there, in every mode (the tool's switch counts as the user's own). */
export const COMMANDS_CARD_PODMAN = "Podman uses this distro, so Ember asks before every command here.";

/** What runs, what is dangerous, and what each mode does with a dangerous command. */
export const COMMANDS_CARD_ASKS = `Most commands run straight away, ones Ember doesn't know included. A command is dangerous if it deletes or overwrites data, pushes or publishes anywhere, shows passwords or keys, changes the system, downloads and runs code or would keep running after you stop Ember, and so is code Ember can't read. In Interactive, the default, Ember asks you before a dangerous command, unless you asked for exactly that command and it ${EXACT_ONLY}: then it shows it first, with a few seconds to stop it. In Assisted, it goes ahead when a check finds the command in what you asked for, and asks otherwise. In Autopilot, it asks nothing and tells you as it goes.`;

/** What holds in every mode: the user's no, and the two switches that make every command ask. */
export const COMMANDS_CARD_ALWAYS = "In every mode, Ember doesn't run again a command you said no to in a task, and it asks before every command wherever your organisation, or your own “Ask me before every command” for that computer, says so.";

/** Where a command's output goes, what Autopilot keeps from the model, and what a steered task does next (`service`: "GitHub Copilot" or the organisation's). */
export const commandsCardOutput = (service: string): string =>
  `What a command prints goes to ${service} as part of the task. Ember hides passwords and keys it recognises, and never sees what you type into a command. In Autopilot, what a command that shows passwords or keys prints is kept from ${service}: only you see it, in the command window. If a command prints something that looks like instructions, Ember doesn't follow it, and in Interactive every further command in that task asks you first.`;
