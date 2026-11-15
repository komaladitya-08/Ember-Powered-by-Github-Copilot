# When Ember asks

This is the owner's rule for when Ember asks before it does something, in the owner's own words, and how to apply it.
It is the first thing to read before changing the approval modes, the command classifier, the policy, a card that
describes them, or before judging a review finding about any of them. Where the code or another document says
otherwise, this page wins and the other is the bug.

## The rule, as the owner said it

Owner decision of 2026-11-12 (the three modes) and of 2026-11-14 (what each one asks):

> Unless they are dangerous commands, Ember shouldn't be asking for each and every command that it wants to run. And
> we can split this work in Interactive, where only dangerous commands; and Assisted is where if my request is about
> running those dangerous commands, then it should allow it; and Autopilot is where it does everything autonomously
> without asking me questions, without asking me any permissions, anything.

A question costs the person their attention and makes Ember slower than doing the thing by hand. Ember asks when the
answer matters, and at no other time.

## What that means

| | Interactive (the default) | Assisted | Autopilot |
|---|---|---|---|
| An ordinary command or step | Runs, announced | Runs, announced | Runs, announced |
| A program, a tool's command or an option Ember doesn't know | Runs, announced | Runs, announced | Runs, announced |
| Something dangerous | Asks | Goes ahead when the person's own request was about it; otherwise asks | Runs, announced; no question |

**Dangerous** means, and only means: deleting or overwriting what can't be got back; publishing or sending (a push, a
publish, a deploy, a message, a file's contents leaving the computer); reading or printing secrets; system changes
and commands as root or an administrator; downloading code and running it; and anything that would keep running
after Stop.

**Not knowing something is not danger.** A program Ember has never seen, a verb or an option that isn't in its
tables, a wrapper around an ordinary command: these run, announced with their Stop, by name. They do not ask.

**Autopilot asks nothing.** Where a question used to protect something, Autopilot protects it another way, without a
question:

- A command that reads secrets runs, and its output is kept from the model (the person sees it in the command
  window). No secret reaches the model.
- Something the person said no to, earlier in the task or in the words of their request, is refused. It is not asked
  again and not worked around.
- A command that would outlive Stop runs, and the announcement and the audit log say that Stop will not reach it.

Two things still ask in Autopilot because they are the person's or their organisation's own explicit settings, not
Ember's doubts: "Ask me before every command" for a particular computer, and the organisation's policy.

## What the modes never change

Refusals are not questions, and no mode loosens one: tampering with Ember's own Stop, audit log, settings, policy or
mode; typing into the person's terminals; password, secret and payment fields outside the vault's fill; the system's
own authentication prompts; never-look windows; everything else under "Never" in CLAUDE.md. Every command and step is
still announced and written to the audit log, Stop still stops Ember, and consent is still asked once for what Ember
reads, sends and keeps.

## How to apply it

- **A dangerous command that ran without a question in Interactive is the worst kind of bug here.** Fix it by
  teaching Ember to recognise that danger: what the command does (deletes, overwrites, sends, prints secrets,
  discards work, runs downloaded code), however it is spelled. Never fix it by making everything Ember doesn't know
  ask.
- **A question about an ordinary command is a bug too.** So is any question in Autopilot other than the two settings
  above, and a question in Assisted about something the person's own request plainly asked for. Reviews and ratings
  count these as faults, not as caution.
- **Before acting on a finding that says "this runs unasked", ask whether the thing is dangerous.** If it is not, the
  finding is wrong. If it is, the fix is recognition.
- **Do not trade a question for safety.** When something must be protected and the mode does not ask, use a refusal,
  keep the output from the model, or say plainly in the announcement what will happen. "When in doubt, fail closed"
  is about refusing and withholding, not about asking more.
- **Words follow behaviour.** A card, a line in Home, the README and CLAUDE.md say what each mode does as the table
  has it. A card whose text changes is agreed again, once (`FEATURE_CONSENT_VERSION`).
- **A change to this page is the owner's.** An integrator or a reviewer who thinks a row should be stricter writes it
  down as a question for the owner, with both sides, and builds nothing on it until the owner answers.

## One point the owner has not yet ruled on

Code Ember cannot read at all (inline code in a language it does not parse, a script the task itself has just
written, a program fed from a pipe or a variable Ember can't see) may be any of the dangerous things. It asks in
Interactive, goes to Assisted's check, and runs in Autopilot. The owner may say that this, too, should run in
Interactive.

## Why this page exists

Between 12 and 14 November 2026 the product audit moved the commands lane away from this rule three times, each time
to close a review finding, and each time by adding questions:

1. A "closed default" made every program Ember had no row for ask, so that about half of the ordinary commands that
   used to run asked.
2. Autopilot was given six questions it kept (secrets, outliving Stop, an effect Ember can't tell, the person's own
   no, the same danger as an earlier no, and the two settings), though the owner had asked for a mode that asks
   nothing.
3. Round eleven's commands work was told to "close by capability, with the safe side as the default", which meant
   asking about every option and every piece of code Ember did not know.

Each was recorded as "settled by the integrator, for the owner to overrule", and each read the standing instruction
"never weaken a safety rule; when in doubt, fail closed" as "when in doubt, ask". The owner overruled all three on 14
November. The lesson is the section above: recognise danger better, refuse or withhold where something must be
protected, and treat a needless question as a defect.
