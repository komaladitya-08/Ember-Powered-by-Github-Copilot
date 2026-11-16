import { expect, it } from "vitest";
import { KEY_VALUE, keyValueSteps, runSteps, runStepsYielding, SECRET_HIDDEN } from "../../app/main/commands/redact";

it.each(["token=value ", `${"token".repeat(60)}: value `])("permits cancellation while discovering overlapping spans in %j output", unit => {
  const text = unit.repeat(12_000) + "password=final-value";
  const steps = keyValueSteps(text);
  expect(steps.next()).toEqual({ done: false, value: undefined });
  expect(steps.return(undefined as never)).toEqual({ done: true, value: undefined });
  expect(steps.next()).toEqual({ done: true, value: undefined });
  const expected = text.replace(KEY_VALUE, (match, keep: string, _suffix: string, value: string) => value.startsWith("[secret") ? match : keep + SECRET_HIDDEN);
  expect(runSteps(keyValueSteps(text))).toBe(expected);
});

it("observes revocation during span discovery without returning partially redacted text", async () => {
  let polls = 0;
  const text = "token=private-value ".repeat(12_000);
  const result = await runStepsYielding(keyValueSteps(text), () => ++polls > 1);
  expect(result).toBeNull();
  expect(polls).toBe(2);
});
