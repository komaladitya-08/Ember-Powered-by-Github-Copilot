import { expect, it } from "vitest";
import { codingDraftChecksLine, codingDraftNameValid } from "../../app/renderer/home/coding-drafts";

it("requires a nonblank bounded single-line saved draft name", () => {
  for (const name of ["", " \t", "a".repeat(81), "name\nother", "name\tother", "name\u202eother"]) expect(codingDraftNameValid(name)).toBe(false);
  expect(codingDraftNameValid("Parser changes")).toBe(true); expect(codingDraftNameValid("a".repeat(80))).toBe(true);
});
it("presents stored checks as history that must run again for a new request", () => {
  expect(codingDraftChecksLine({ ran: 3, passed: 2, failed: 1 })).toBe("Historical checks: 3 run, 2 passed, 1 failed. Run required checks again for a new request.");
});
