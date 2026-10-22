/**
 * Never-rules for actions on other targets' windows, called at the top of decideBase's never-rules (§4.5; owned by
 * package WB). STUB from Step 0a: no extra rule (null), so every decision is today's.
 */

import type { OS } from "../../shared/shortcuts";
import type { ActionRequest, Decision } from "./policy";

/** A refusal for this request on a WSL or remote window (the wsl: tier-3 rule), or null to decide as usual. */
export function targetRules(_r: ActionRequest, _os: OS): Decision | null {
  return null;
}
