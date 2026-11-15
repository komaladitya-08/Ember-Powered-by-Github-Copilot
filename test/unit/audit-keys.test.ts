/** What the audit file keeps of a key press: a key that types a character is typed text, kept only as a count. */

import { describe, expect, it } from "vitest";
import { auditValue } from "../../app/main/agent/worker";
import type { ActionRequest } from "../../app/main/policy/policy";

const press = (value: string): ActionRequest => ({ taskId: "t", kind: "keys", value, app: "gedit", window: "notes.txt - gedit" });

describe("auditValue", () => {
  it.each(["a", "A", "shift+a", "7", "space", "KP_1", "é", "exclam"])("keeps a key that types “%s” as one character, never the key (safety-privacy-r9-5)", value => {
    expect(auditValue(press(value))).toEqual({ chars: 1 });
  });

  it.each(["ctrl+s", "Return", "Tab", "BackSpace", "Delete", "Escape", "alt+F4", "ctrl+shift+t", "Up"])("keeps “%s”, which types nothing, as the key (safety-privacy-r9-5)", value => {
    expect(auditValue(press(value))).toEqual({ value });
  });

  it("keeps typed text as its length and a choice in full, as before", () => {
    expect(auditValue({ ...press(""), kind: "text", value: "hello", mode: "append" })).toEqual({ chars: 5, mode: "append" });
    expect(auditValue({ ...press(""), kind: "select", value: "Vegetarian" })).toEqual({ value: "Vegetarian" });
  });
});
