/**
 * Best-effort secret redaction for command output and command lines (design §3.11 step 4, §3.5.4's "tokens on the
 * command line"). Pure: the PC shapes every run's output with it before the model sees it (a run's end in steps, with
 * Ember's main thread given back between passes: redactSteps), and the classifier uses the same patterns to notice a
 * token typed into a command. It can miss secrets (that is stated to the
 * model and in the commands consent card); what it never does is reach for anything outside its argument.
 */

/** What every redacted value becomes. */
export const SECRET_HIDDEN = "[secret hidden]";

/**
 * Private key blocks. Hidden by hidePrivateKeys, not by a global replace: the regex engine retries every later BEGIN
 * line when no END follows, which is quadratic on output that repeats one (a hostile remote can print that).
 */
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;

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
  // SendGrid keys, DigitalOcean tokens and Twilio API keys, each a fixed shape (safety-privacy-r7-3).
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /\bdo[opr]_v1_[a-f0-9]{64}\b/g,
  /\bSK[0-9a-f]{32}\b/g,
  // More fixed shapes (commands-remote-r9-9): age keys, PyPI, Vault, Google OAuth, 1Password service and Doppler
  // tokens, Telegram and Discord bot tokens, and a password hash as /etc/shadow and htpasswd write it.
  /\bAGE-SECRET-KEY-1[A-Z0-9]{50,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{50,}/g,
  /\bhv[sbr]\.[A-Za-z0-9_-]{24,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bops_[A-Za-z0-9+/=_-]{50,}/g,
  /\bdp\.(?:st|ct|pt|sa|scim|audit)\.[A-Za-z0-9._-]{20,}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  /\b[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}(?![A-Za-z0-9_-])/g,
  /\$(?:1|2[aby]?|5|6|y|apr1|argon2(?:id|i|d)?)\$[A-Za-z0-9./$=,+-]{20,}/g,
  // Django's generated secret key (commands-remote-r10-6).
  /\bdjango-insecure-[^\s"',;]{8,}/g,
];

/**
 * The whole-token patterns that stay inside one token: TOKEN_PATTERNS without private key blocks, whose match can run
 * across lines and quotes. The logger's redactor (../secret-text.ts) uses them on finished JSON lines.
 */
export const TOKEN_SHAPES: readonly RegExp[] = TOKEN_PATTERNS.filter(re => re !== PRIVATE_KEY);

/**
 * An Azure Key Vault secret's value in `az keyvault secret show`'s JSON (VALUE_PATTERNS says how), and in the REST
 * API's shape, value first. Each looks up to 4,000 steps on from every secret id, so 4 MiB of ids took one pass about
 * 1.6 s; neither can match without both `vault.azure.net/secrets/` and `"value"` in the text, which VALUE_NEEDS checks
 * first (stop-yield-x9-left-1).
 */
const VAULT_VALUE = /(vault\.azure\.net\/secrets\/[^"]{0,200}"(?:[^{}]|\{[^{}]{0,4000}\}){0,4000}?"value"\s{0,8}:\s{0,8}")(?:[^"\\]|\\.)*(?=")/g;
const VAULT_VALUE_FIRST = /("value"\s{0,8}:\s{0,8}")(?:[^"\\]|\\.)*(?="(?:\s{0,8},\s{0,8}"\w{1,40}"\s{0,8}:\s{0,8}(?:"(?:[^"\\]|\\.){0,200}"|[\w.+-]{1,40})){0,3}\s{0,8},\s{0,8}"id"\s{0,8}:\s{0,8}"[^"]{0,200}vault\.azure\.net\/secrets\/)/g;
/**
 * Text a value pattern can't match without, whole: a pass whose text lacks any of it is the text as it was, the same
 * bytes, without the pattern's search (UNGUARDED_PASSES is the proof's other side).
 */
const VALUE_NEEDS: ReadonlyMap<RegExp, readonly string[]> = new Map([
  [VAULT_VALUE, ["vault.azure.net/secrets/", '"value"']],
  [VAULT_VALUE_FIRST, ["vault.azure.net/secrets/", '"value"']],
]);

/** Patterns whose first group is kept and whose value is hidden. */
/** The words before `_KEY` that say the key is a secret one (`SECRET_KEY`, `API_KEY`, `SIGNING_KEY`: r10-commands-y10-6). */
const SECRET_KEY_WORDS =
  "SECRET|API|PRIVATE|ACCESS|SIGNING|ENCRYPTION|ENC|MASTER|CLIENT|SESSION|LICENSE|LICENCE|ACCOUNT|SERVICE|DEPLOY|HMAC|JWT|AUTH|APP|CRYPTO|CIPHER|SSH|GPG|PGP|" +
  "secret|api|private|access|signing|encryption|enc|master|client|session|license|licence|account|service|deploy|hmac|jwt|auth|app|crypto|cipher|ssh|gpg|pgp";
/**
 * A value that looks like a key or a scheme's credential: 8 or more letters, digits and `+/=_.-` with a letter and a
 * digit among them, to the value's end (`created_at`, `id`, `on` and `D` are not: r10-commands-y10-6).
 */
const KEY_SHAPED = String.raw`["']?(?:(?:Basic|Bearer|Token|Digest|Negotiate|basic|bearer|token)[ \t]+|(?=[A-Za-z+/=_.-]{0,255}\d)(?=[0-9+/=_.-]{0,255}[A-Za-z])[A-Za-z0-9+/=_.-]{8,}(?![^\s"',;}\]]))`;

const VALUE_PATTERNS: readonly RegExp[] = [
  /(aws_secret_access_key\s*[=:]\s*)\S+/gi,
  /(AccountKey=)[^;\s]+/g,
  /(SharedAccessSignature=)[^;\s]+/g,
  /(Authorization:\s*(?:Bearer|Basic|token)\s+)\S+/gi,
  // An Azure SAS signature, a session cookie a server sets, a Wi-Fi key as nmcli and netsh print it, and the value of
  // an Azure Key Vault secret in `az keyvault secret show`'s JSON (commands-remote-r9-9).
  /([?&;]sig=)[A-Za-z0-9%+/=_-]{20,}/g,
  /(set-cookie:[ \t]*[^=;\s]{0,64}=)[^;\s]+/gi,
  /((?:802-11-wireless-security|wifi-sec)\.(?:psk|wep-key\d|leap-password)[ \t]*:[ \t]*)\S+/g,
  /(Key Content[ \t]*:[ \t]*)\S+/g,
  // Between the id and the value stand the secret's other fields, its tags among them, which are an object of their
  // own (`"tags": {}`, `{"env": "prod"}`): each is stepped over whole, so a tag named "value" is never taken for the
  // secret's, and the value ends at its closing quote, not at one written `\"` inside it (commands-classes-x9-7).
  VAULT_VALUE,
  // The REST API's shape (`az rest`, curl against the vault) prints the value first, then the secret's id, with at most
  // a few plain fields between (`"contentType": "text/plain"`): each look is bounded, so a run of values stays linear
  // (merge review integ-y-3).
  VAULT_VALUE_FIRST,
  // A Docker config's `"auth": "<base64 of user:password>"`, and a .netrc entry written on one line
  // (`machine host login bob password …`); a password on a line of its own is not told from prose (safety-privacy-r7-3).
  // An entry is told by its login, or with none by a dotted host: "the default password is admin" and "machine learning
  // password reset" are sentences, and hiding their next word made commands and notes that say them hold a secret
  // (regression review of round seven, safety-privacy-x7-2).
  /("auth"\s{0,8}:\s{0,8}")[A-Za-z0-9+/]{16,}={0,2}(?=")/g,
  /(\b(?:(?:machine[ \t]+\S+|default)(?:[ \t]+(?:login|account)[ \t]+\S+){1,2}|machine[ \t]+[\w-]+(?:\.[\w-]+)+)[ \t]+password[ \t]+)\S+/g,
  // A webhook's address is its own key: whoever has it can post (Slack, Discord, Teams; commands-remote-r10-6).
  /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/g,
  /(discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/)[A-Za-z0-9_-]+/g,
  /(\.webhook\.office\.com\/webhookb2\/)[^\s"'<>]+/g,
  // A variable as `env`, `ps e` and a .env file print it whose name ends in a short secret word after a `_` or is that
  // word (`DB_PASS=`, `REDIS_AUTH=`, `MYSQL_PW=`, `SIGNING_KEY=`, `AUTH=`, `PASSPHRASE=`), which KEY_VALUE's words
  // miss; never a variable, a placeholder or what is already hidden, nor PWD and OLDPWD, which are folders, nor a
  // filter's or a renderer's LOW_PASS, HIGH_PASS, BAND_PASS or RENDER_PASS (memory-x6-5; commands-remote-r10-6). The
  // name is at most 64 characters before its word, so each start is a bounded look.
  // An authorisation scheme's credential is hidden with it (`AUTH=Basic dXNl…`, `HTTP_AUTH=Bearer …`: r10-commands-x10-5).
  // A KEY is hidden when its name says it is a secret one (`SECRET_KEY`, `STRIPE_API_KEY`, `SIGNING_KEY`); any other
  // KEY, and AUTH or KEY alone, only when its value looks like a key (8 or more letters and digits, both) or a scheme's
  // credential: `SORT_KEY=created_at`, `PRIMARY_KEY=id`, `?key=abc` and `AUTH=on` are ordinary facts, and memory refused
  // them as secrets (r10-commands-y10-6). PUBLIC_, SORT_, PRIMARY_ and FOREIGN_KEY are never hidden.
  new RegExp(String.raw`((?<![A-Za-z0-9_.-])(?!(?:OLD)?PWD=|(?:LOW|HIGH|BAND|ALL|RENDER)_PASS=|(?:[A-Za-z0-9_]{0,64}_)?(?:PUBLIC|SORT|PRIMARY|FOREIGN|public|sort|primary|foreign)_(?:KEY|key)=)(?:(?:(?:[A-Za-z0-9_]{0,64}_)?(?:PASS|PASSPHRASE|PW|PWD|pass|passphrase|pw|pwd)|[A-Za-z0-9_]{0,64}_(?:AUTH|auth)|(?:[A-Za-z0-9_]{0,64}_)?(?:${SECRET_KEY_WORDS})_(?:KEY|key))=["']?|(?:[A-Za-z0-9_]{0,64}_)?(?:KEY|key|AUTH|auth)=["']?(?=${KEY_SHAPED})))(?![$%{<*[])(?:(?:Basic|Bearer|Token|Digest|Negotiate|basic|bearer|token)[ \t]+)?[^\s"',;]+`, "g"),
  // The same names as YAML and JSON print them (`docker compose config`'s `DB_PASS: hunter2`, `"REDIS_AUTH": "abc"`):
  // at a line's start, after a list's `- `, or after `{`, `[` or `,`, so prose keeps its words; a bare lower-case `key:`,
  // `pass:` or `auth:` (a selector's key, a field) needs a prefix (r10-commands-x10-5).
  new RegExp(String.raw`((?:^|\n|[{[,])[ \t]*(?:-[ \t]+)?(?<q>["']?)(?!(?:OLD)?PWD\k<q>[ \t]*:|(?:LOW|HIGH|BAND|ALL|RENDER)_PASS\k<q>[ \t]*:|(?:[A-Za-z0-9_]{0,64}_)?(?:PUBLIC|SORT|PRIMARY|FOREIGN|public|sort|primary|foreign)_(?:KEY|key)\k<q>[ \t]*:)(?:(?:[A-Za-z0-9_]{0,64}_(?:PASS|PASSPHRASE|AUTH|PW|PWD|PASSWD|pass|passphrase|auth|pw|pwd|passwd)|(?:[A-Za-z0-9_]{0,64}_)?(?:${SECRET_KEY_WORDS})_(?:KEY|key)|PASS|PASSPHRASE|PW|PASSWD|passphrase)\k<q>[ \t]*:[ \t]*["']?|(?:[A-Za-z0-9_]{0,64}_(?:KEY|key)|KEY|AUTH)\k<q>[ \t]*:[ \t]*["']?(?=${KEY_SHAPED})))(?![$%{<*[])(?:(?:Basic|Bearer|Token|Digest|Negotiate|basic|bearer|token)[ \t]+)?[^\s"',;}\]]+`, "g"),
  // A table's row whose first column names a secret, as `pulumi config --show-secrets`, `pulumi stack output` and
  // `netlify env:list` print them (`dbPassword   Tr0ub4dor&3`, `│ DB_PASSWORD │ hunter2 │`): the next column is hidden
  // (commands-remote-c10-1), or a single tab (`DB_PASSWORD\thunter2`: r10-commands-x10-5). Only at a line's start, the
  // name a bounded look.
  /((?:^|\n)[ \t]*(?:[│|][ \t]*)?[A-Za-z0-9_.-]{0,64}?(?:[Pp]assword|PASSWORD|[Pp]asswd|PASSWD|[Pp]assphrase|PASSPHRASE|[Ss]ecret|SECRET|[Tt]oken|TOKEN|[Cc]redentials?|CREDENTIALS?|(?<=[a-z0-9])Key|(?<=[_.-])(?:[Kk]ey|KEY|[Pp]ass|PASS|[Pp]wd|PWD|[Aa]uth|AUTH))(?![A-Za-z0-9_.-])(?:[ \t]{2,}|\t|[ \t]*[│|][ \t]*))(?![│|[])[^\s│|]+/g,
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

/**
 * The same passwords where the arguments are a list, each its own element, not one line (memory-q6-1): a compose
 * file's exec-form healthcheck (`test: ["CMD", "mysqladmin", "ping", "-phunter2"]`), a subprocess or execFile list,
 * `docker inspect`'s Test array (one element a line) and YAML's lists (`[CMD, mysqladmin, -phunter2]`, or a `- ` a
 * line). An element is quoted or bare; elements are parted by a comma (and the bracket of a list that is the next
 * argument: `execFile("mysql", ["-p…"])`) or by a new line's `- `.
 */
const LIST_SEP = String.raw`(?:[ \t]*,\s*\[?|[ \t]*\n[ \t]*-[ \t]+)`;
const LIST_ELEMENT = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"',[\]]+)`;
/** What may stand between a program and its option in a list: at most 12 other elements. */
const LIST_ARGS = String.raw`(?:${LIST_SEP}${LIST_ELEMENT}){0,12}?`;
/**
 * A program as a list's element, alone or with its folder, before the next element: after the line's start, a space,
 * a comma, a bracket or its own quote, so a long run of other characters is looked at once; never an option's folder
 * (`"-I/usr/include/mysql"`).
 */
const listProgram = (names: string): string => String.raw`(?<![^\s,["'])(?:(?!-)[^\s"',[\]]*[\/\\])?(?:${names})(?:\.[eE][xX][eE])?["']?(?=${LIST_SEP})`;
/** An element that is exactly `option`, with the quote (`q`) it opens with, if any. */
const listOption = (option: string): string => String.raw`${LIST_SEP}(?<q>["']?)(?:${option})`;
const LIST_NOT_VALUE = String.raw`(?![$%{<*[])`;
const LIST_HOLDER = String.raw`(?:[A-Z][A-Z_]*|(?:your[-_]?|my[-_]?)?(?:password|passwd|pass|pwd|secret|token|key))`;
/**
 * A list element's value, which is hidden: after `opened` (what the element starts with: nothing, or an attached
 * option such as `-p`), to the element's closing quote, or for a bare element to the comma, bracket or line's end.
 * Never a variable, a template or a placeholder, as OPTION_VALUE.
 */
const listValue = (opened: string, quoted = String.raw`[^\n]`): string =>
  String.raw`(?:(?<=["']${opened})${LIST_NOT_VALUE}(?!${LIST_HOLDER}\k<q>)(?:(?!\k<q>)${quoted})+(?=\k<q>)`
  + String.raw`|(?<!["']${opened})${LIST_NOT_VALUE}(?!${LIST_HOLDER}(?![^\s"',\]]))[^\s"',\]]+(?=[ \t]*(?:[,\]\n]|$)))`;
/** The option as one element and its value as the next, in the same quotes. */
const listPair = (option: string): string => String.raw`${listOption(option)}\k<q>${LIST_SEP}\k<q>`;
const SECRET_OPTION = String.raw`--?(?:[A-Za-z0-9]+[-_.])*(?:password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)`;
/** An option that switches the secret off and takes no value (`"--no-password"`: memory-x7-1). */
const LIST_SWITCH_OFF = String.raw`--?no[-_]`;
/**
 * Words that say an option has no value or what type its value is, never a secret themselves (`["--token", "none"]`,
 * argparse's `"store_true"`, a table's `"string"`), whole: `"none1234"` and `"strings"` are values (memory-x7-1).
 */
const LIST_NO_VALUE = String.raw`(?:[Nn]one|[Nn]ull|nil|undefined|[Ss]tr(?:ing)?|int(?:eger)?|bool(?:ean)?|float|store_(?:true|false|const))`;
/**
 * OPTION_PASSWORDS for lists of arguments: `keep` stays and `value` is hidden. MySQL's and MariaDB's `"-p…"` (a bare
 * `"-p"` prompts, and `"-P"` is a port), `"-p", "…"` after sshpass, mongo's clients and a registry's login,
 * `"-a", "…"` after redis-cli, `"-u", "admin:…"` after curl and wget, `"-U", "admin%…"` after smbclient, openssl's
 * `"-k", "…"` and `"-pass", "pass:…"`, and, after any program, a quoted option named like a secret with the next
 * quoted element as its value (`"--password", "…"`: three characters or more with no space, never another option, so
 * `"-pass", "1"` and an option's description stay). That last one is told by how it is written, wherever the list is
 * built (a call's first arguments, a tuple: memory-y7-2), so it leaves only what can't be a value (memory-x7-1): after
 * an option that takes none (`LIST_SWITCH_OFF`), a word for no value or a type (`LIST_NO_VALUE`), and, checked where
 * it's replaced, a mapping's value and next key (`inMapping`: `"name": "--password", "description": …`) and the
 * option's own name exactly (`ownName`: click's `"--api-key", "api_key"`).
 */
const LIST_PASSWORDS: readonly RegExp[] = [
  new RegExp(String.raw`(?<keep>${listProgram(CLIENT)}${LIST_ARGS}${listOption("-p")})(?<value>${listValue("-p")})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("sshpass|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport")}${LIST_ARGS}${listOption("-p")}(?:\k<q>${LIST_SEP}\k<q>)?)(?<value>${listValue("(?:-p)?")})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("docker|podman|nerdctl|buildah|helm")}${LIST_ARGS}${LIST_SEP}["']?login["']?${LIST_ARGS}${listPair("-p|--password")})(?<value>${listValue("")})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("redis-cli")}${LIST_ARGS}${listPair("-a")})(?<value>${listValue("")})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("curl|wget")}${LIST_ARGS}${listPair("-u|--user")}[^\s"',:\]]*:)(?<value>${listValue(String.raw`[^\s"',:\]]*:`)})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("smbclient")}${LIST_ARGS}${listPair("-U")}[^\s"',%\]]*%)(?<value>${listValue(String.raw`[^\s"',%\]]*%`)})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("openssl")}${LIST_ARGS}${listPair("-k")})(?<value>${listValue("")})`, "g"),
  new RegExp(String.raw`(?<keep>${listProgram("openssl")}${LIST_ARGS}${listPair("-pass(?:in|out)?")}pass:)(?<value>${listValue("pass:")})`, "g"),
  new RegExp(String.raw`(?<keep>(?<![^\s,[(])(?<q>["'])(?!${LIST_SWITCH_OFF})(?<option>${SECRET_OPTION})\k<q>${LIST_SEP}\k<q>)(?<value>(?!-)${LIST_NOT_VALUE}(?!(?:${LIST_HOLDER}|${LIST_NO_VALUE})\k<q>)(?:(?!\k<q>)\S){3,})(?=\k<q>)`, "g"),
];

/**
 * Whether a list element after `option` is that option's own name as code writes it, not its value: exactly its name
 * with "_" for "-" (click's `"--api-key", "api_key"`: memory-x7-1). Anything more is a value: `"api_key_9f8e7d6c"`,
 * `"Auth_Token"`, and a dest with words before it (`"--token", "auth_token"`), since `"s3cr3t_token"` would pass too.
 */
function ownName(option: string, value: string): boolean {
  return value === option.replace(/^-+/, "").toLowerCase().replace(/[-.]/g, "_");
}

/**
 * Whether the pair at `at` (from its option's opening quote, `q`) is a mapping's value and the next key, not an option
 * and its value: the option follows a ":" and what would be its value is followed by one (`"name": "--password",
 * "description": …`: memory-x7-1). Never a `case "--password", "…":` with no ":" before it. Looks a bounded way back.
 */
function inMapping(text: string, at: number, end: number, q: string): boolean {
  return /:[ \t]*$/.test(text.slice(Math.max(0, at - 32), at)) && new RegExp(String.raw`^${q}[ \t]*:`).test(text.slice(end, end + 34));
}

/** URL credentials: `://user:pass@` (and `://:pass@`, a password with no user: commands-remote-r10-6) becomes `://[secret hidden]@`. */
const URL_CREDENTIALS = /:\/\/[^/\s:@]*:[^/\s@]+@/g;

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
 * URLs, a password given to a program's short option, on its line or as an element of a list of arguments (OPTION_PASSWORDS, LIST_PASSWORDS), and the values of keys named like passwords, tokens or
 * keys. Best effort: it can miss secrets.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pass of REDACT_PASSES) out = pass(out);
  return out;
}

/**
 * redactSecrets's passes, in order: each reads and replaces in the whole text it is given, as redactSecrets folds them.
 * A pass can match across lines (a private key block, a list's `\n- ` separator), so the text is never cut into
 * slices; a caller that must keep Ember's main thread free between passes runs them one at a time
 * (redactSecretsYielding) and gets the same bytes, since it is the same list (merge review integ-y-2).
 */
const passes = (guarded: boolean): readonly ((text: string) => string)[] => [
  ...TOKEN_PATTERNS.map(re => (re === PRIVATE_KEY ? hidePrivateKeys : (t: string) => t.replace(re, SECRET_HIDDEN))),
  ...VALUE_PATTERNS.map(re => (t: string) => (guarded && !(VALUE_NEEDS.get(re) ?? []).every(n => t.includes(n)) ? t : t.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN))),
  ...OPTION_PASSWORDS.map(re => (t: string) => t.replace(re, (_m, keep: string, quote: string, _value: string, after?: string) => `${keep}${quote}${SECRET_HIDDEN}${quote}${typeof after === "string" ? after : ""}`)),
  ...LIST_PASSWORDS.map(re => (t: string) => t.replace(re, (...m) => {
    const g = m[m.length - 1] as { keep: string; value: string; q?: string; option?: string };
    const [match, at, whole] = [String(m[0]), m[m.length - 3] as number, m[m.length - 2] as string];
    const leave = g.option !== undefined && (ownName(g.option, g.value) || inMapping(whole, at, at + match.length, g.q ?? ""));
    return leave ? match : `${g.keep}${SECRET_HIDDEN}`;
  })),
  t => t.replace(URL_CREDENTIALS, `://${SECRET_HIDDEN}@`),
  t => t.replace(KEY_VALUE, (m, keep: string, _suffix: string, value: string) => (value.startsWith("[secret") ? m : keep + SECRET_HIDDEN)),
];
/** redactSecrets's passes (above), each value pattern checked first for the text it can't match without (VALUE_NEEDS). */
export const REDACT_PASSES: readonly ((text: string) => string)[] = passes(true);
/** The same passes without VALUE_NEEDS's check: what REDACT_PASSES must equal byte for byte (commands-redact.test.ts). */
export const UNGUARDED_PASSES: readonly ((text: string) => string)[] = passes(false);

/**
 * redactSecrets as steps: a step before each of REDACT_PASSES, so a caller can let other work run between them
 * (output.ts cleanOutputAsync). Nothing but this generator holds the text between steps.
 */
export function* redactSteps(text: string): Generator<void, string, void> {
  let out = text;
  for (const pass of REDACT_PASSES) {
    yield;
    out = pass(out);
  }
  return out;
}

/** Runs steps to their end at once: what the synchronous functions return. */
export function runSteps<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** One macrotask: whatever is waiting on Ember's main thread (the stop shortcut's handler, a timer) runs first. */
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * How long steps run before a macrotask is given (ms): a step is a whole-text pass, often well under a millisecond on
 * short output, and a turn for each would add up where a run printed many secret prompts.
 */
export const STEP_SLICE_MS = 8;

/**
 * Runs steps, giving a macrotask once STEP_SLICE_MS has passed since the last, and stops at the first step where
 * `stopped()` says so: null then, and nothing of the text the steps held goes anywhere (merge review integ-y-2: the
 * kill switch's handler must get the thread within 300 ms while up to 4 MiB of a run's output is cleaned). `work`
 * counts the steps run and the macrotasks given.
 */
export async function runStepsYielding<T>(steps: Generator<void, T, void>, stopped: () => boolean, work?: { steps: number; turns: number }): Promise<T | null> {
  let since = performance.now();
  for (;;) {
    if (stopped()) {
      steps.return(undefined as never);
      return null;
    }
    const r = steps.next();
    if (work) work.steps++;
    if (r.done) return r.value;
    if (performance.now() - since >= STEP_SLICE_MS) {
      await turn();
      if (work) work.turns++;
      since = performance.now();
    }
  }
}

/**
 * redactSecrets with Ember's main thread given back between its passes: the same bytes, or null once `stopped()`
 * says so.
 */
export function redactSecretsYielding(text: string, stopped: () => boolean, work?: { steps: number; turns: number }): Promise<string | null> {
  return runStepsYielding(redactSteps(text), stopped, work);
}

/**
 * PRIVATE_KEY's global replace, in linear time: each BEGIN line up to the first END line after it becomes one hidden
 * value; once a BEGIN has no END after it, no later one has either, so the search stops there.
 */
function hidePrivateKeys(text: string): string {
  // PGP's armour says "PRIVATE KEY BLOCK" (commands-remote-r9-9).
  const begin = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
  const end = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
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
