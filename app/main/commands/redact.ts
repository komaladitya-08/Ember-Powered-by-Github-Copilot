/**
 * Best-effort secret redaction for command output and command lines (design §3.11 step 4, §3.5.4's "tokens on the
 * command line"). Pure and synchronous: the PC shapes every run's output with it before the model sees it, and the
 * classifier uses the same patterns to notice a token typed into a command. It can miss secrets (that is stated to the
 * model and in the commands consent card); what it never does is reach for anything outside its argument.
 */

/** What every redacted value becomes. */
export const SECRET_HIDDEN = "[secret hidden]";

/**
 * Private key blocks. Hidden by hidePrivateKeys, not by a global replace: the regex engine retries every later BEGIN
 * line when no END follows, which is quadratic on output that repeats one (a hostile remote can print that).
 */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Whole-match token patterns (§3.11 step 4), in the order they are applied. Each one runs in time linear in its input:
 * output can be megabytes of one unbroken token, and redaction runs on Ember's main thread.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // GitHub tokens.
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  PRIVATE_KEY,
  // JSON web tokens. The first part stops at the next "-eyJ", so a run like "-eyJ-eyJ-eyJ…" is read once, not once
  // per "eyJ" in it.
  /\beyJ(?:[A-Za-z0-9_]|-(?!eyJ)){10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Slack.
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  // Google API keys.
  /AIza[0-9A-Za-z_-]{35}/g,
  // npm.
  /npm_[A-Za-z0-9]{36}/g,
];

/** Patterns whose first group is kept and whose value is hidden. */
const VALUE_PATTERNS: readonly RegExp[] = [
  /(aws_secret_access_key\s*[=:]\s*)\S+/gi,
  /(AccountKey=)[^;\s]+/g,
  /(SharedAccessSignature=)[^;\s]+/g,
  /(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi,
  // The same secret-named options OPTION_SECRET notices (`--db-pass=x`): the option name with its `=` stays, the
  // value is hidden. The leading space or quote is kept too, prose words like "compass" never reach a value this way.
  /((?:^|[\s"'])--?(?:[A-Za-z0-9]+[-_.])*(?:password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)=)[^\s"',;]+/gi,
];

/** URL credentials: `://user:pass@` becomes `://[secret hidden]@`. */
const URL_CREDENTIALS = /:\/\/[^/\s:@]+:[^/\s@]+@/g;

/**
 * Key-value pairs whose key names a secret: `password=…`, `token: …`, `"api_key": "…"` (the value only). The key may
 * carry a prefix or suffix (`DB_PASSWORD`, `client_secret_id`); the value runs to whitespace, a quote, a comma or a
 * semicolon. A value that is already hidden is left alone. The match starts at the secret word (a prefix stays in the
 * text as it is) and the suffix is at most 256 characters, taken whole (a lookahead and its back-reference: none of its
 * characters can start the `=` or `:` after it, so giving any back never helps). That is a constant per start, so the
 * time stays linear: an open-ended class on either side made every start in a long run of letters rescan the whole
 * run, which froze Ember for minutes on one long token of output.
 */
const KEY_VALUE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)(?=([A-Za-z0-9_.-]{0,256}))\2["']?\s*(?:=|:)\s*["']?)([^\s"',;]+)/gi;

/**
 * Replaces what looks like a secret in `text` with "[secret hidden]" (§3.11 step 4): GitHub, AWS, Slack, Google and
 * npm tokens, private key blocks, JWTs, Azure account keys and SAS signatures, Authorization headers, credentials in
 * URLs, and the values of keys named like passwords, tokens or keys. Best effort: it can miss secrets.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = re === PRIVATE_KEY ? hidePrivateKeys(out) : out.replace(re, SECRET_HIDDEN);
  for (const re of VALUE_PATTERNS) out = out.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN);
  out = out.replace(URL_CREDENTIALS, `://${SECRET_HIDDEN}@`);
  out = out.replace(KEY_VALUE, (m, keep: string, _suffix: string, value: string) => (value.startsWith("[secret") ? m : keep + SECRET_HIDDEN));
  return out;
}

/**
 * PRIVATE_KEY's global replace, in linear time: each BEGIN line up to the first END line after it becomes one hidden
 * value; once a BEGIN has no END after it, no later one has either, so the search stops there.
 */
function hidePrivateKeys(text: string): string {
  const begin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
  const end = /-----END [A-Z ]*PRIVATE KEY-----/g;
  let out = "";
  let at = 0;
  for (;;) {
    begin.lastIndex = at;
    const b = begin.exec(text);
    if (!b) break;
    end.lastIndex = b.index + b[0].length;
    const e = end.exec(text);
    if (!e) break;
    out += text.slice(at, b.index) + SECRET_HIDDEN;
    at = e.index + e[0].length;
  }
  return at === 0 ? text : out + text.slice(at);
}

/**
 * `NAME=value` on a command line with a secret-looking name (the `=` form only: "token: fix" in a commit message is
 * prose, `API_TOKEN=abc` isn't). PWD and OLDPWD are folders, not passwords.
 */
const ASSIGNED_SECRET =
  /(?:^|[\s"'])(?!(?:OLD)?PWD=)[A-Za-z0-9_]*?(?:password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|client_?secret)[A-Za-z0-9_]*=[^\s"',;]+/i;
/**
 * An option whose name ends in a secret word, with a value: `--password=x`, `--db-pass=x`, `--auth-token=x` (not
 * `--max-tokens=100` or `--tokenizer=fast`).
 */
const OPTION_SECRET =
  /(?:^|[\s"'])--?(?:[A-Za-z0-9]+[-_.])*(?:password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)=[^\s"',;]+/i;

/**
 * Whether a word of a command line holds a password or token (§3.5.4 "tokens on the command line"): one of step 4's
 * token patterns, an Authorization header, credentials in a URL, a secret-named `NAME=value`, or a secret-named option
 * with its value (`--password=x`).
 */
export function commandLineSecret(word: string): boolean {
  return WORD_PATTERNS.some(re => re.test(word));
}

/** The same patterns without the global flag (a global pattern's `test` keeps state between calls). */
const WORD_PATTERNS: readonly RegExp[] = [...TOKEN_PATTERNS, ...VALUE_PATTERNS, URL_CREDENTIALS]
  .map(re => new RegExp(re.source, re.flags.replace("g", "")))
  .concat(ASSIGNED_SECRET, OPTION_SECRET);
