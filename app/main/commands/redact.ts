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
export const TOKEN_PATTERNS: readonly RegExp[] = [
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
  // OpenAI (sk-, sk-proj-, sk-svcacct-, sk-admin-) and Anthropic (sk-ant-api03-) keys: 32 or more key characters,
  // with a digit among the first 40 (a bounded look, so a long run of "sk-" stays linear), so a kebab-case word that
  // happens to start "sk-" isn't one (safety-privacy-2).
  /\bsk-(?:proj-|svcacct-|admin-|ant-[a-z]{2,8}\d{2}-)?(?=[A-Za-z0-9_-]{0,40}\d)[A-Za-z0-9_-]{32,}/g,
  // Stripe secret and restricted keys, and webhook signing secrets.
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{24,}/g,
  // Hugging Face and GitLab tokens.
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
];

/**
 * The whole-token patterns that stay inside one token: TOKEN_PATTERNS without private key blocks, whose match can run
 * across lines and quotes. The logger's redactor (../secret-text.ts) uses them on finished JSON lines.
 */
export const TOKEN_SHAPES: readonly RegExp[] = TOKEN_PATTERNS.filter(re => re !== PRIVATE_KEY);

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

/**
 * A value that is a password itself, never a variable, a template or a placeholder: not `$DB_PASS`, `%PW%`, `{{ pw }}`,
 * `<password>`, `*` (a prompt), capitals alone (`-pPASSWORD` in a README) or a word for one (`yourpassword`), nor an
 * unquoted redirection (`> .htpasswd`: memory-x6-4).
 */
const OPTION_VALUE = String.raw`(?![$%{<*[])(?!(?<!["'])>)(?![A-Z][A-Z_]*(?![^\s"'|;&]))(?!(?:your[-_]?|my[-_]?)?(?:password|passwd|pass|pwd|secret|token|key)(?![^\s"'|;&]))[^\s"'|;&]+`;
/** What may stand between a program and its option on one line: other words, at most 200 characters, never a pipe or `;`. */
const ARGS = String.raw`(?:[ \t]+[^\s|;&]+){0,12}?`;
/**
 * A folder a program is run from: absolute, relative, the home folder's, a variable's, a drive's or a share's (`/usr/bin/`,
 * `bin/`, `bin\`, `~/mysql/bin/`, `$HOME/opt/`, `${MYSQL_HOME}/`, `$(MYSQL_DIR)/`, `%MYSQL_HOME%\`, `$env:ProgramFiles\`,
 * `(x86)\`, `C:\xampp\`, `\\db01\tools\`), never an option (`-I/usr/…`): memory-y6-1, memory-z6-1.
 */
const FOLDER_PART = String.raw`(?:[A-Za-z]:|\$\{\w+\}|\$?\(\w+\)|%\w+%|\$env:\w+|\$?[\w.~-]+)`;
const FOLDER = String.raw`(?!-)${FOLDER_PART}?[\/\\]+(?:${FOLDER_PART}[\/\\]+)*`;
/**
 * Where a command word starts. The program's name after anything but a letter, a digit, `_`, a folder's `/` or `\`, a
 * `-` (an option or another name: `--with-mysql`, `php-mysql`) or a host's `@` (`admin@mysql`): a space, a quote, a
 * shell's separator, a prompt or a tag (`C:\xampp\mysql\bin>mysql`, `<code>mysql`, `#mysql`), a comment's mark
 * (`#mysqldump`, `//mysql`, `<!--mysql`), a variable (`$(Q)mysql`) or a setting's "=" (`DB_CMD=mysql`). Its folder after
 * anything but what a folder holds or a URL's or a volume's ":" (`/data:/var/lib/mysql`). At a line's start after a
 * Makefile recipe's or a unit's prefix (`\t@mysql`, `\t-mysql`, `ExecStartPre=-/usr/bin/mysql`), a "-" only before a
 * folder or the program, never an option (`\t-I/usr/include/mysql`). Never an option's value (`--user=mysql`,
 * `--with-mysql=/usr/local/mysql`) or an include or a library folder (`-I /usr/include/mysql`, `-L …`,
 * `-isystem …`). A run of these characters is looked back over once, at its end, so a long one stays linear:
 * memory-y6-1, memory-z6-1.
 */
const LINE_HEAD = String.raw`(?:^|\n)[ \t]*(?:[A-Za-z_][\w.-]*[ \t]*=)?`;
const LINE_START = String.raw`(?<=${LINE_HEAD}(?:[-@+!:]*[@+!:])?)|(?=[\/~$.\\]|m)(?<=${LINE_HEAD}[-@+!:]*-)|(?<=<!--)`;
const NOT_AN_OPTION = String.raw`(?<!(?<![\w.-])--?[\w.-]*=)(?<!(?:^|\s)-(?:I|L|isystem|iquote|idirafter)[ \t]*)`;
const FOLDER_START = String.raw`(?:(?=[\/\\])(?<![\w.~\/\\:-])(?<!\$?\(\w+\)|\$\{\w+\}|%\w+%)|(?![\/\\])(?<![\w.~$\/\\:-])|${LINE_START})${NOT_AN_OPTION}`;
const NAME_START = String.raw`(?:(?<![\w\/\\-])(?<!\S@)|${LINE_START})${NOT_AN_OPTION}`;
const COMMAND_START = String.raw`(?=[\w.~$%(\/\\])(?:${FOLDER_START}${FOLDER}|${NAME_START})`;
/**
 * The clients' names, in lower case, capitalised as a sentence's first word (`Mysql -u …`) or in a variable's capitals;
 * on Windows, whose names have no case, an .exe in any case.
 */
const CLIENT = String.raw`(?:mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlslap|mysqlpump|mysqlbinlog|mysqlsh|mysql_upgrade|mysql_secure_installation|mariadb(?:-(?:dump|admin|import|check|show|slap|binlog|upgrade|backup|secure-installation))?|mariabackup)`;
const CLIENT_NAME = String.raw`(?:${CLIENT}|${CLIENT.replace(/(?<=^\(\?:|\|)m/g, "M")}|${CLIENT.toUpperCase()})`;
const ANY_CASE = CLIENT.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
/**
 * MySQL's and MariaDB's clients, whose `-p` is a password, as a command word: alone or with its folder (COMMAND_START,
 * FOLDER), as `sudo mysql`, `docker exec db mysql`, `$(mysql …)`, `bin/mysql` or a Makefile's `\t@mysql`, by a
 * variable's capitals (`$(MYSQL)`, `%MYSQLDUMP%`), and before a closing quote or bracket (`"C:\…\mysql.exe" -u`,
 * `“mysql -u …”`); never a library, a folder or another program in a build line (`-I/usr/include/mysql -pthread`,
 * `mysqlclient -pthread`, `mysql_config --cflags -pipe`, `$(MYSQL_CFLAGS) -pthread`, `--user=mysql -pid-file=…`):
 * memory-x6-4, memory-y6-1, memory-z6-1.
 */
const MYSQL_CLIENT = String.raw`${COMMAND_START}(?:${CLIENT_NAME}(?:\.[eE][xX][eE])?|${ANY_CASE}\.[eE][xX][eE])`
  + String.raw`["'\`\u2019\u201d)\]}%*]{0,3}(?=[ \t])`;
/** htpasswd's options and the numbers some take (`-nbB -C 10`), one of them with `b` (the password on the line). */
const HTPASSWD_OPTIONS = String.raw`(?=(?:[ \t]+-[A-Za-z]+(?:[ \t]+\d+)?)*?[ \t]+-[A-Za-z]*b)(?:[ \t]+-[A-Za-z]+(?:[ \t]+\d+)?)+`;
/** A word that is no shell operator (`>`, `<`, `|`). */
const HTPASSWD_WORD = String.raw`(?![<>|])\S+`;
/**
 * Programs whose short option carries a password (safety-privacy-c5-2): each pattern's first group is kept, its second is
 * the value's quote and its third the value, which is hidden. `mysql -pWint3r!Sh0p` and `mysql -p'…'` (attached; a
 * bare `-p` prompts), `curl -u admin:…` and `--user admin:…` (after the colon), `docker login -p …`, `mongo -p …`,
 * `sshpass -p …`, `redis-cli -a …`, `smbclient -U admin%…`, `htpasswd -b file user …` and `htpasswd -nb user …` (to its
 * output: no file), `openssl … -k …` and `-pass pass:…`, `net use \\srv\share … /user:admin …`, and `echo '…' | sudo -S`.
 */
const OPTION_PASSWORDS: readonly RegExp[] = [
  new RegExp(String.raw`(${MYSQL_CLIENT}${ARGS}[ \t]+-p)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\b(?:curl|wget)${ARGS}[ \t]+(?:-u|--user)(?:[ \t]+|=)["']?[^\s"':|;&]*:)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\b(?:docker|podman|nerdctl|buildah|helm)${ARGS}[ \t]+login${ARGS}[ \t]+(?:-p|--password)[ \t]+)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\b(?:mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)${ARGS}[ \t]+-p[ \t]*)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bsshpass${ARGS}[ \t]+-p[ \t]*)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bredis-cli${ARGS}[ \t]+-a[ \t]+)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bsmbclient${ARGS}[ \t]+-U[ \t]*["']?[^\s"'%|;&]+%)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bhtpasswd(?=(?:[ \t]+-[A-Za-z]+(?:[ \t]+\d+)?)*?[ \t]+-[A-Za-z]*n)${HTPASSWD_OPTIONS}[ \t]+${HTPASSWD_WORD}[ \t]+)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bhtpasswd(?!(?:[ \t]+-[A-Za-z]+(?:[ \t]+\d+)?)*?[ \t]+-[A-Za-z]*n)${HTPASSWD_OPTIONS}[ \t]+${HTPASSWD_WORD}[ \t]+${HTPASSWD_WORD}[ \t]+)(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bopenssl${ARGS}[ \t]+(?:-k[ \t]+|-pass(?:in|out)?[ \t]+pass:))(["']?)(${OPTION_VALUE})\2`, "g"),
  new RegExp(String.raw`(\bnet[ \t]+use${ARGS}[ \t]+/user:\S+[ \t]+)(["']?)(${OPTION_VALUE})\2`, "gi"),
  new RegExp(String.raw`(\bnet[ \t]+use(?:[ \t]+[A-Za-z]:)?[ \t]+\\\\\S+[ \t]+)(["']?)((?!/)${OPTION_VALUE})\2`, "gi"),
  new RegExp(String.raw`(\b(?:echo|printf)[ \t]+(?:-\w+[ \t]+)*)(["']?)(${OPTION_VALUE})\2([ \t]*\|[ \t]*sudo(?:[ \t]+-\w+)*[ \t]+-\w*S)`, "g"),
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
 * Replaces what looks like a secret in `text` with "[secret hidden]" (§3.11 step 4): GitHub, AWS, Slack, Google, npm,
 * OpenAI, Anthropic, Stripe, Hugging Face and GitLab tokens and keys, private key blocks, JWTs, Azure account keys and SAS signatures, Authorization headers, credentials in
 * URLs, a password given to a program's short option (OPTION_PASSWORDS), and the values of keys named like passwords, tokens or
 * keys. Best effort: it can miss secrets.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = re === PRIVATE_KEY ? hidePrivateKeys(out) : out.replace(re, SECRET_HIDDEN);
  for (const re of VALUE_PATTERNS) out = out.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN);
  for (const re of OPTION_PASSWORDS) {
    out = out.replace(re, (_m, keep: string, quote: string, _value: string, after?: string) => `${keep}${quote}${SECRET_HIDDEN}${quote}${typeof after === "string" ? after : ""}`);
  }
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
