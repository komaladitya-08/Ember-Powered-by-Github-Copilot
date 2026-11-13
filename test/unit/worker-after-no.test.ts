/**
 * How a task ends after the user said no, or nobody answered, with nothing done after it (worker.ts afterNo): the
 * model's "Done" can't stand where the task's own record shows no step that worked (tasks-approvals-r9-4).
 */

import { describe, expect, it } from "vitest";
import { afterNo } from "../../app/main/agent/worker";

describe("a task's end after a no or a question nobody answered", () => {
  it("is declined, never done, when the model says it succeeded but no step worked (tasks-approvals-r9-4)", () => {
    expect(afterNo({ declined: true, expired: false, worked: false }, { success: true, summary: "Deleted all the old notes." }))
      .toEqual({ success: false, stopped: true, declined: true, summary: "You said not now, so I left it." });
    expect(afterNo({ declined: false, expired: true, worked: false }, { success: true, summary: "Deleted all the old notes." }))
      .toEqual({ success: false, stopped: true, expired: true, summary: "My question ran out of time with no answer, so I didn't do it." });
  });

  it("keeps the model's words where it says it didn't succeed, as before", () => {
    expect(afterNo({ declined: true, expired: false, worked: false }, { success: false, summary: "I left the notes as they are." }))
      .toMatchObject({ declined: true, summary: "I left the notes as they are." });
    expect(afterNo({ declined: true, expired: false, worked: false }, null)).toMatchObject({ declined: true, summary: "You said not now, so I left it." });
  });

  it("takes the model's success where a step worked in the task, and leaves a task with no no alone", () => {
    expect(afterNo({ declined: true, expired: false, worked: true }, { success: true, summary: "Saved the draft; I didn't send it." })).toBeNull();
    expect(afterNo({ declined: false, expired: false, worked: false }, { success: true, summary: "Answered." })).toBeNull();
  });
});
