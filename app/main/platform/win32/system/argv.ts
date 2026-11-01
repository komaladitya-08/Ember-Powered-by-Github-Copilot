/**
 * A shortcut's argument string split into words the way Windows programs see them: CommandLineToArgvW's rules for
 * the words after the program (the same as the C runtime's), in TypeScript so the app catalogue needs no native
 * call. Ember never runs these words itself (explorer.exe launches the shortcut); they only let the terminal check
 * see what a shortcut starts (a shortcut to `cmd.exe /k vsdevcmd.bat` is cmd). Pure.
 *
 * The rules (CommandLineToArgvW, as Wine reproduces them from Windows' own behaviour):
 * - words are separated by spaces and tabs outside quotes;
 * - 2n backslashes then a quote give n backslashes, and the quote opens or closes a quoted part;
 * - 2n+1 backslashes then a quote give n backslashes and a literal quote;
 * - backslashes not followed by a quote are literal;
 * - inside a quoted part, every third quote of a run of quotes is a literal quote (`"a""b"` is `a"b`).
 */

/** The words of a Windows argument string (without a program name in front). */
export function splitWindowsArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "", inWord = false, backslashes = 0, quotes = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if ((c === " " || c === "\t") && quotes === 0) {
      if (inWord) out.push(cur + "\\".repeat(backslashes)); // (a backslash always starts a word)
      cur = "";
      inWord = false;
      backslashes = 0;
      i++;
      continue;
    }
    inWord = true;
    if (c === "\\") {
      backslashes++;
      i++;
      continue;
    }
    if (c === '"') {
      cur += "\\".repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) {
        cur += '"'; // escaped: a literal quote
      } else {
        quotes++;
      }
      backslashes = 0;
      i++;
      // A run of quotes: every third one is a literal quote, and an even count leaves the quoted part closed.
      while (s[i] === '"') {
        if (++quotes === 3) {
          cur += '"';
          quotes = 0;
        }
        i++;
      }
      if (quotes === 2) quotes = 0;
      continue;
    }
    cur += "\\".repeat(backslashes) + c;
    backslashes = 0;
    i++;
  }
  if (inWord) out.push(cur + "\\".repeat(backslashes));
  return out;
}
