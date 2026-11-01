/**
 * Secret prompts in a run's output (design L2, §3.11 step 2): no termios is read (that would need native code on the
 * far side), so a password-like prompt at the end of the output opens a "secret span" that is withheld from the model
 * until the program's next line after the user presses Enter. On a run that can't take typing (pipes) nothing closes a
 * span: it runs to the end of the output, so even a partial prompt line's answer never reaches the model (critique
 * security-12). Pure: RUN's and SC's runners feed it the decoded output as it comes; offsets are characters of that
 * decoded text, which shapeOutput decodes the same way.
 */

/** The prompt line the output must end in (exactly §3.11 step 2's pattern). */
export const SECRET_PROMPT =
  /(password|passphrase|passcode|pin|otp|token|secret|verification code|one-time code|2fa code|\[sudo\] password for [^:]*)[^\n]{0,40}[:：]\s*$/i;

/** The `to` of a span that is still open: it runs to the end of whatever output there is. */
export const OPEN_SPAN_END = Number.MAX_SAFE_INTEGER;

/** One per run: fed the decoded output as it comes and told when the user presses Enter (interactive runs only). */
export interface SecretTracker { output(text: string): void; enter(): void; spans(): { from: number; to: number }[] }

/** Terminal escape sequences, removed from the line before it is matched (a coloured prompt is still a prompt). */
// eslint-disable-next-line no-control-regex -- terminal escape sequences are exactly what this removes
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_]|[ -/]+[0-~])|[\x9b][0-?]*[ -/]*[@-~]/g;

/** At most this much of the current line is kept for matching (a prompt is short; a progress bar isn't a prompt). */
const LINE_KEEP = 4096;

/**
 * A tracker for one run. `interactive`: the user can type into it (a PTY, or a pipe whose stdin is open), so Enter
 * followed by the program's next newline closes a span; otherwise every span stays open to the end.
 */
export function trackSecretPrompts(o: { interactive: boolean }): SecretTracker {
  const done: { from: number; to: number }[] = [];
  let seen = 0;
  /** The current, unterminated output line (raw, capped). */
  let line = "";
  /** The open span's start, or null. */
  let open: number | null = null;
  /** The user pressed Enter while the span was open: the next newline closes it. */
  let entered = false;

  const atPromptEnd = (): boolean => {
    const plain = line.replace(ESCAPES, "");
    const last = plain.slice(plain.lastIndexOf("\r") + 1);
    return SECRET_PROMPT.test(last);
  };

  return {
    output(text: string): void {
      for (let k = 0; k < text.length; k++) {
        const c = text[k];
        const at = seen + k;
        if (open !== null) {
          if (o.interactive && entered && c === "\n") {
            done.push({ from: open, to: at });
            open = null;
            entered = false;
            line = "";
          }
          continue;
        }
        if (c === "\n") line = "";
        else if (line.length < LINE_KEEP) line += c;
        else line = line.slice(LINE_KEEP / 2) + c;
      }
      seen += text.length;
      // Only the output as it now stands can end in a prompt: the program is waiting for an answer.
      if (open === null && line !== "" && atPromptEnd()) {
        open = seen;
        entered = false;
      }
    },
    enter(): void {
      if (open !== null && o.interactive) entered = true;
    },
    spans(): { from: number; to: number }[] {
      return open === null ? done.map(s => ({ ...s })) : [...done.map(s => ({ ...s })), { from: open, to: OPEN_SPAN_END }];
    },
  };
}
