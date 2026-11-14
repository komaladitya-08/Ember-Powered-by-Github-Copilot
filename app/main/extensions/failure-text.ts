/**
 * A failed extension call's text as the model gets it. The runtime passes a server's failure (a JSON-RPC error's
 * message, an `isError` result's text) to the model as it is, and the SDK's failure hook can only add a note beside it,
 * never rewrite it. So Ember's launcher (launch.ts `passedOn`), which every server's answers go through, rewrites that
 * text the way a result is wrapped (gate.ts `wrapResult`): in Ember's own tag, marked untrusted, `<` and `>` replaced,
 * hidden characters written out, and flagged where it holds hidden characters or markup that looks like Ember's own
 * (r12-ui-x12-2: such a failure no longer tainted the conversation, and reached the model raw, so a server could close
 * Ember's tags and open a "user request" of its own). The failure hook (service.ts `failure`) taints a flagged one.
 * No imports: the launcher is bundled on its own (dist/app/mcp-launch.cjs).
 */

/** Characters that reorder or hide text, as gate.ts writes them out of a call's arguments (format characters, variation selectors, blank look-alikes). */
export const HIDDEN_CHARS = /[\p{Cf}\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\u{e0000}-\u{e007f}]|\u034f|\u17b4|\u17b5|\u180b|\u180c|\u180d|\u180f|[\ufe00-\ufe0f]|[\u{e0100}-\u{e01ef}]/gu;

/**
 * Markup a server has no reason to write in a failure, because it reads as Ember's own: its tags for untrusted text
 * (`<extension_result>`, `<screen>`), a user's or a system's turn, a tool's call. An HTML error page's own tags
 * (`<html>`, `<body>`, `<h1>`) are not among them: an ordinary 404 from a web server isn't flagged.
 */
const LOOKS_EMBERS = /<\s*\/?\s*(?:extension_|user|untrusted|screen|system|assistant|tool|function|instruction)|\buntrusted\s*=/i;

/** Ember's tag around a failure's text; the flagged one says the text held hidden characters or Ember-like markup. */
export const FAILURE_OPEN = '<extension_failure untrusted="true">';
export const FAILURE_FLAGGED_OPEN = '<extension_failure untrusted="true" flagged="true">';
export const FAILURE_CLOSE = "</extension_failure>";

/** Hidden characters written out (\u202e, \u{e0049}), so the model reads what a person would see. */
function writtenOut(s: string): string {
  return s.replace(HIDDEN_CHARS, c => {
    const n = c.codePointAt(0)!;
    return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, "0")}`;
  });
}

/** Whether a server's failure text holds hidden characters or markup that looks like Ember's own. */
export function failureFlagged(raw: string): boolean {
  return new RegExp(HIDDEN_CHARS.source, "u").test(raw) || LOOKS_EMBERS.test(raw);
}

/** A server's failure text as the launcher passes it on: in Ember's tag, untrusted, its `<` and `>` and hidden characters made harmless. */
export function failureText(raw: string): string {
  const shown = writtenOut(raw).replace(/</g, "‹").replace(/>/g, "›");
  return `${failureFlagged(raw) ? FAILURE_FLAGGED_OPEN : FAILURE_OPEN}\n${shown}\n${FAILURE_CLOSE}`;
}

/**
 * Whether a failure as the failure hook gets it (the runtime's prefix, then the launcher's tag) taints the conversation
 * for what it is made of: the launcher flagged it, or, outside Ember's own tags, it still holds hidden characters or
 * Ember-like markup (text that didn't come through the launcher). Its words are judged as a result's are, elsewhere.
 */
export function failureTaints(seen: string): boolean {
  if (seen.includes(FAILURE_FLAGGED_OPEN)) return true;
  const rest = seen.split(FAILURE_OPEN).join("").split(FAILURE_CLOSE).join("");
  return failureFlagged(rest);
}
