/**
 * Customise › Schedules: the open session's scheduled prompts (session `schedule.list`: what is sent, how often and
 * when next), each stopped with `schedule.stop` (confirmed), and how to make one in words (the /every and /after
 * commands, sent in the composer).
 */
import { SCHEDULES, SCHEDULES_HOW, SCHEDULES_NONE, SCHEDULE_STOP, SCHEDULE_STOPPED, scheduleStopLabel, scheduleStopQuestion, scheduleWhen } from "./copy-customise";
import { confirmed, defineSection, list, load, part, row } from "./customise-kit";
import { scheduleRows } from "./customise-read";
import { el } from "./dom";

defineSection("Schedules", "session", ctx => ({
  draw(body) {
    if (!ctx.session()) { body.replaceChildren(el("p", { className: "hint", textContent: SCHEDULES_HOW })); return; }
    const p = part(SCHEDULES, { lead: SCHEDULES_HOW });
    body.replaceChildren(p.root);
    const fill = () => load(p.body, () => ctx.call("session", "schedule.list"), v => list(SCHEDULES, scheduleRows(v).map(s => row({
      name: s.prompt, lines: [scheduleWhen(s)],
      actions: [confirmed(SCHEDULE_STOP, scheduleStopQuestion(s.prompt), SCHEDULE_STOP, async () => {
        const r = await ctx.call("session", "schedule.stop", { id: s.id });
        ctx.say(r.ok ? SCHEDULE_STOPPED : r.reason);
        if (r.ok) void fill();
      }, { aria: scheduleStopLabel(s.prompt) })],
    })), SCHEDULES_NONE));
    void fill();
  },
}));
