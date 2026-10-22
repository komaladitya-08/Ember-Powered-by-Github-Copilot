/**
 * Text a command carries from elsewhere in its task (§3.8.3 step 7; owned by package AG, built on policy.ts's runsIn).
 * STUB from Step 0a: every command counts as carrying text from an unknown source, so a decision that uses it always
 * asks (fail closed).
 */

import type { OS } from "../../shared/shortcuts";
import type { ReadSource } from "../policy/policy";

/** Where text in `text` was read in this task (its sources' names), or null when it carries none. */
export function carriedText(_text: string, _sources: ReadSource[], _words: string, _os: OS): { from: string[] } | null {
  return { from: ["unknown"] };
}
