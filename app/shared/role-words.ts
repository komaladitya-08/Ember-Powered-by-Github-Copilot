/**
 * Plain words for the screen reader's control roles (review #220), shared by the May I? question (policy.ts) and the
 * activity list in settings (home/copy.ts), so both call a control the same thing: "button", not "push button";
 * "drop-down", not "combo box". Windows and macOS controls arrive in the same AT-SPI vocabulary (sidecar-host roles.ts),
 * so one table serves every OS. Renderer-safe: no Node or Electron import.
 */

/** A role's plain word, without an article; a role not here keeps the screen reader's own name. */
export const ROLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "push button": "button", button: "button", "toggle button": "switch", switch: "switch", "check box": "checkbox",
  "radio button": "option", text: "text field", entry: "text field", "password text": "password field",
  "combo box": "drop-down", "menu item": "menu item", "list item": "list item", link: "link", slider: "slider",
  "spin button": "number field", "page tab": "tab", "page tab list": "tab list", "tool bar": "toolbar",
  "root pane": "window", static: "text",
});

/** What a control is called in a sentence: "button", "drop-down", or the role itself when the table has no word. */
export const roleWord = (role: string): string => (Object.prototype.hasOwnProperty.call(ROLE_WORDS, role) ? ROLE_WORDS[role] : role);

/** The plain word with its article ("a button", "an option"); a role with no plain word keeps its own name, bare. */
export function aRoleWord(role: string): string {
  if (!Object.prototype.hasOwnProperty.call(ROLE_WORDS, role)) return role;
  const w = ROLE_WORDS[role];
  return `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`;
}
