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
  // OpenShift's sign-in token (`oc whoami -t`: r12-commands-y12-8).
  /\bsha256~[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
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
  // A Telegram bot's token, in its API's address too (`api.telegram.org/bot<id>:<token>/`: r10-commands-y10-7).
  /(?:\b|(?<=\/bot))\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
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

/** The unchanged environment assignment pattern always requires a literal equals sign. */
const ENVIRONMENT_ASSIGNMENT = new RegExp(String.raw`((?<![A-Za-z0-9_.-])(?!(?:OLD)?PWD=|(?:LOW|HIGH|BAND|ALL|RENDER)_PASS=|(?:[A-Za-z0-9_]{0,64}_)?(?:PUBLIC|SORT|PRIMARY|FOREIGN|public|sort|primary|foreign)_(?:KEY|key)=)(?:(?:(?:[A-Za-z0-9_]{0,64}_)?(?:PASS|PASSPHRASE|PW|PWD|pass|passphrase|pw|pwd)|[A-Za-z0-9_]{0,64}_(?:AUTH|auth)|(?:[A-Za-z0-9_]{0,64}_)?(?:${SECRET_KEY_WORDS})_(?:KEY|key))=["']?|(?:[A-Za-z0-9_]{0,64}_)?(?:KEY|key|AUTH|auth)=["']?(?=${KEY_SHAPED})))(?![$%{<*[])(?:(?:Basic|Bearer|Token|Digest|Negotiate|basic|bearer|token)[ \t]+)?[^\s"',;]+`, "g");
/**
 * Text a value pattern can't match without, whole: a pass whose text lacks any of it is the text as it was, the same
 * bytes, without the pattern's search (UNGUARDED_PASSES is the proof's other side).
 */
const VALUE_NEEDS: ReadonlyMap<RegExp, readonly string[]> = new Map([
  [VAULT_VALUE, ["vault.azure.net/secrets/", '"value"']],
  [VAULT_VALUE_FIRST, ["vault.azure.net/secrets/", '"value"']],
  [ENVIRONMENT_ASSIGNMENT, ["="]],
]);

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
  // (`machine host login bob password …`, Emacs's .authinfo with its `port` too: commands-remote-r12-1); a password on a
  // line of its own is CONFIG_PATTERNS' (safety-privacy-r7-3).
  // An entry is told by its login, or with none by a dotted host: "the default password is admin" and "machine learning
  // password reset" are sentences, and hiding their next word made commands and notes that say them hold a secret
  // (regression review of round seven, safety-privacy-x7-2).
  /("auth"\s{0,8}:\s{0,8}")[A-Za-z0-9+/]{16,}={0,2}(?=")/g,
  /(\b(?:(?:machine[ \t]+\S+|default)(?:[ \t]+(?:login|account|port|user)[ \t]+\S+){1,3}|machine[ \t]+[\w-]+(?:\.[\w-]+)+)[ \t]+password[ \t]+)\S+/g,
  // A webhook's address is its own key: whoever has it can post (Slack, Discord, Teams; commands-remote-r10-6).
  /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]+/g,
  /(discord(?:app)?\.com\/api\/webhooks\/\d{1,30}\/)[A-Za-z0-9_-]+/g,
  /(\.webhook\.office\.com\/webhookb2\/)[^\s"'<>]+/g,
  // Outlook's older connector address and Zapier's catch hook (r10-commands-y10-7).
  /(outlook\.office(?:365)?\.com\/webhook\/)[^\s"'<>]+/g,
  /(hooks\.zapier\.com\/hooks\/catch\/)[A-Za-z0-9_/-]+/g,
  // A `value` whose sibling `name` says a secret, as Kubernetes and Azure print an environment (`- name: DB_PASSWORD`
  // then `value: …`, `{"name": "API_TOKEN", "value": "…"}`): the name a bounded look, on its line or the next
  // (r10-commands-y10-7).
  new RegExp(String.raw`((?:^|\n|[{,])[ \t]*(?:-[ \t]+)?(?<nq>["']?)name\k<nq>[ \t]*:[ \t]*(?<vq>["']?)[A-Za-z0-9_.-]{0,64}?(?:PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|CREDENTIALS?|_PASS|_PW|_PWD|_AUTH|(?:SECRET|API|PRIVATE|ACCESS|SIGNING|ENCRYPTION|MASTER|CLIENT)_KEY|[Pp]assword|[Ss]ecret|[Tt]oken)\k<vq>[ \t]*,?[ \t]*(?:\r?\n[ \t]*)?(?<q>["']?)value\k<q>[ \t]*:[ \t]*["']?)(?![$%{<*[])[^\s"',;}\]]+`, "g"),
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
  ENVIRONMENT_ASSIGNMENT,
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
/** MySQL's password option requires a literal `-p`; skip its command/folder lookbehinds when that option is absent. */
const MYSQL_PASSWORD = new RegExp(String.raw`(${MYSQL_CLIENT}${ARGS}[ \t]+-p)(["']?)(${OPTION_VALUE})\2`, "g");
/**
 * Programs whose short option carries a password (safety-privacy-c5-2): each pattern's first group is kept, its second is
 * the value's quote and its third the value, which is hidden. `mysql -pWint3r!Sh0p` and `mysql -p'…'` (attached; a
 * bare `-p` prompts), `curl -u admin:…` and `--user admin:…` (after the colon), `docker login -p …`, `mongo -p …`,
 * `sshpass -p …`, `redis-cli -a …`, `smbclient -U admin%…`, `htpasswd -b file user …` and `htpasswd -nb user …` (to its
 * output: no file), `openssl … -k …` and `-pass pass:…`, `net use \\srv\share … /user:admin …`, and `echo '…' | sudo -S`.
 */
const OPTION_PASSWORDS: readonly RegExp[] = [
  MYSQL_PASSWORD,
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
const listProgram = (names: string): string => String.raw`(?<![^\s,["'])(?:(?!-)[^\s"',[\]]*[\/\\])?${listProgramName(names)}`;
/** listProgram past its folder: the name, an .exe, its closing quote and the separator after it. */
const listProgramName = (names: string): string => String.raw`(?:${anyCase(names)})(?:\.[eE][xX][eE])?["']?(?=${LIST_SEP})`;
/**
 * A program's names in any case, letter by letter (`[mM][yY]…`, no flag, so the rest of a pattern keeps its case): a
 * list may name it `"mYsQl"`, `"Redis-Cli"` or `"CURL.EXE"`, which Windows and macOS run as the program (memory-y7-1).
 */
function anyCase(names: string): string {
  return names.replace(/[a-z]/g, c => `[${c}${c.toUpperCase()}]`);
}
/** htpasswd's options as list elements (`"-nbB", "-C", "10"`), one of them with `b`; with `n` when `n` is given. */
const listHtpasswd = (n: boolean): string => {
  const opt = String.raw`${LIST_SEP}["']?-[A-Za-z]+["']?(?:${LIST_SEP}["']?\d+["']?)?`;
  return String.raw`(?=(?:${opt}){0,3}?${LIST_SEP}["']?-[A-Za-z]*b)${n ? "" : "(?!"}(?=(?:${opt}){0,3}?${LIST_SEP}["']?-[A-Za-z]*n)${n ? "" : ")"}(?:${opt}){1,4}`;
};
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
const SECRET_OPTION_WORD = String.raw`(?:password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)`;
const SECRET_OPTION = String.raw`--?(?:[A-Za-z0-9]+[-_.])*${SECRET_OPTION_WORD}`;
/** An option that switches the secret off and takes no value (`"--no-password"`: memory-x7-1). */
const LIST_SWITCH_OFF = String.raw`--?no[-_]`;
/**
 * Words that say an option has no value or what type its value is, never a secret themselves (`["--token", "none"]`,
 * argparse's `"store_true"`, a table's `"string"`), whole: `"none1234"` and `"strings"` are values (memory-x7-1).
 */
const LIST_NO_VALUE = String.raw`(?:[Nn]one|[Nn]ull|nil|undefined|[Ss]tr(?:ing)?|int(?:eger)?|bool(?:ean)?|float|store_(?:true|false|const))`;
/**
 * A value that only says where the password is read from, as openssl's `-pass` takes it (`env:PW`, `file:pw.txt`,
 * `fd:3`, `stdin`): never the password itself (memory-v7-1).
 */
const LIST_NAMES_SOURCE = String.raw`(?!(?:env|file|fd):[^\s"']|stdin\k<q>)`;
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
/**
 * A row of LIST_PASSWORDS and what each of its matches holds, so listRowSteps tries it only where a match can start:
 * `names`, the programs a row's match starts with (listProgram's), and `tail`, the row from the name on (its `keep`
 * without the folder); or null for both in the row whose match starts at an option's opening quote.
 */
interface ListRow { readonly re: RegExp; readonly names: string | null; readonly tail: string | null }
/** A row whose match starts with a program of `names` (listProgram) and goes on as `rest`. */
const programRow = (names: string, rest: string): ListRow => ({
  re: new RegExp(String.raw`(?<keep>${listProgram(names)}${rest}`, "g"),
  names,
  tail: String.raw`(?<keep>${listProgramName(names)}${rest}`,
});
const LIST_ROWS: readonly ListRow[] = [
  // MySQL's and MariaDB's row, which needs a `-p` in the text: skipped without one, as MYSQL_PASSWORD is.
  programRow(CLIENT, String.raw`${LIST_ARGS}${listOption("-p")})(?<value>${listValue("-p")})`),
  programRow("sshpass|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport", String.raw`${LIST_ARGS}${listOption("-p")}(?:\k<q>${LIST_SEP}\k<q>)?)(?<value>${listValue("(?:-p)?")})`),
  programRow("docker|podman|nerdctl|buildah|helm", String.raw`${LIST_ARGS}${LIST_SEP}["']?login["']?${LIST_ARGS}${listPair("-p|--password")})(?<value>${listValue("")})`),
  programRow("redis-cli", String.raw`${LIST_ARGS}${listPair("-a")})(?<value>${listValue("")})`),
  programRow("curl|wget", String.raw`${LIST_ARGS}${listPair("-u|--user")}[^\s"',:\]]*:)(?<value>${listValue(String.raw`[^\s"',:\]]*:`)})`),
  programRow("smbclient", String.raw`${LIST_ARGS}${listPair("-U")}[^\s"',%\]]*%)(?<value>${listValue(String.raw`[^\s"',%\]]*%`)})`),
  programRow("openssl", String.raw`${LIST_ARGS}${listPair("-k")})(?<value>${listValue("")})`),
  programRow("openssl", String.raw`${LIST_ARGS}${listPair("-pass(?:in|out)?")}pass:)(?<value>${listValue("pass:")})`),
  // htpasswd's `-nb user password` and `-b file user password`, and `net use \\srv\share password` (also after
  // `/user:name`), as their lines are read (memory-v7-1).
  programRow("htpasswd", String.raw`${listHtpasswd(true)}${LIST_SEP}${LIST_ELEMENT}${listOption("")})(?<value>${listValue("")})`),
  programRow("htpasswd", String.raw`${listHtpasswd(false)}${LIST_SEP}${LIST_ELEMENT}${LIST_SEP}${LIST_ELEMENT}${listOption("")})(?<value>${listValue("")})`),
  programRow("net", String.raw`${LIST_SEP}["']?${anyCase("use")}["']?(?:${LIST_SEP}["']?[A-Za-z]:["']?)?${LIST_SEP}["']?\\{2,4}[^\s"',\]]+["']?${listOption("")})(?<value>(?!/)${listValue("")})`),
  programRow("net", String.raw`${LIST_SEP}["']?${anyCase("use")}["']?${LIST_ARGS}${LIST_SEP}["']?/${anyCase("user")}:[^\s"',\]]+["']?${listOption("")})(?<value>(?!/)${listValue("")})`),
  { re: new RegExp(String.raw`(?<keep>(?<![^\s,[(])(?<q>["'])(?!${LIST_SWITCH_OFF})(?<option>${SECRET_OPTION})\k<q>${LIST_SEP}\k<q>)(?<value>(?!-)${LIST_NOT_VALUE}(?!(?:${LIST_HOLDER}|${LIST_NO_VALUE})\k<q>)${LIST_NAMES_SOURCE}(?:(?!\k<q>)\S){3,})(?=\k<q>)`, "g"), names: null, tail: null },
];
const LIST_PASSWORDS: readonly RegExp[] = LIST_ROWS.map(row => row.re);
const LIST_MYSQL = LIST_PASSWORDS[0];

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

/** What a LIST_PASSWORDS match becomes: its `keep` and the hidden mark, or itself where it is no option's value. */
function listReplacement(match: string, at: number, whole: string, g: { keep: string; value: string; q?: string; option?: string }): string {
  const leave = g.option !== undefined && (ownName(g.option, g.value) || inMapping(whole, at, at + match.length, g.q ?? ""));
  return leave ? match : `${g.keep}${SECRET_HIDDEN}`;
}

/**
 * How long a step of the list passes runs before it yields (ms): a whole-text pass of one row took 180 to 195 ms on
 * 4 MiB here and 645 ms on CI's Windows runner, past Stop's 300 ms; the clock is read every LIST_CHECK attempts.
 */
const LIST_STEP_MS = 4;
const LIST_CHECK = 32;
/** How many characters a step's search for a row's programs looks at in one go, and how far windows overlap: more than
 * the longest name a row searches for (`mariadb-secure-installation`, 27), so a name across two windows is whole in one. */
const LIST_WINDOW = 256 * 1024;
const LIST_NAME_REACH = 64;
/** What ends a list element's run of characters: what listProgram's folder and name can't hold. */
const LIST_DELIMITER = /[\s"',[\]]/;
/**
 * LIST_DELIMITER by character code (`\s` is JavaScript's white space and line terminators), for the scan back to a run's
 * start: a regex test per character took 80 ms over a 4 MiB run.
 */
function isListDelimiter(c: number): boolean {
  return c === 32 || c === 34 || c === 39 || c === 44 || c === 91 || c === 93 || (c >= 9 && c <= 13) || (c >= 0xa0 && (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff));
}

/**
 * Whether `text` holds `needle`, a window at a time with a yield every LIST_STEP_MS: a search for "-p" through 4 MiB of
 * `'-` held the thread 18 ms (each "-" a near miss).
 */
function* holds(text: string, needle: string): Generator<void, boolean, void> {
  let due = performance.now() + LIST_STEP_MS;
  for (let from = 0; from < text.length; from += LIST_WINDOW) {
    // Windows overlap by the needle's length less one, so one across their edge is whole in the first.
    if (text.slice(from, from + LIST_WINDOW + needle.length - 1).includes(needle)) return true;
    if (performance.now() >= due) { yield; due = performance.now() + LIST_STEP_MS; }
  }
  return false;
}
/** What listProgram's lookbehind lets stand before a program (or its folder). */
const BEFORE_PROGRAM = /[\s,["']/;
/** An option's opening quote, where the last row's match starts. */
const OPTION_QUOTE = /["']-/g;

/**
 * A program row's match at `start`, the start of a run of characters that holds one of its names and ends at
 * `runEnd`, as the row's own regex finds it there: listProgram's lookbehind, then its folder and the rest (`tail`,
 * sticky). The regex's greedy folder gives back one character at a time and tries the name after every `/` or `\`
 * in the run, back to its start, and then no folder: 4 MiB of `a/` took that one try 100 ms. The name, its .exe and
 * its closing quote are followed by a separator, whose first character ends the run, and the name and .exe hold none
 * (letters, digits, `-`, `_`, `.`), so the name ends where the run does: only a name starting within LIST_NAME_REACH
 * of the run's end can match. Those places are tried in the regex's own order (after the last `/` or `\` first), then
 * the run's start with no folder, so the first that matches is the regex's match.
 */
function programAt(text: string, start: number, runEnd: number, tail: RegExp): { at: number; m: RegExpExecArray } | null {
  if (start > 0 && !BEFORE_PROGRAM.test(text[start - 1])) return null;
  // The folder's `(?!-)`: it can't start with `-`.
  if (text[start] !== "-") {
    for (let at = runEnd - 1; at > start && at >= runEnd - LIST_NAME_REACH; at--) {
      if (text[at - 1] !== "/" && text[at - 1] !== "\\") continue;
      tail.lastIndex = at;
      const m = tail.exec(text);
      if (m) return { at, m };
    }
  }
  tail.lastIndex = start;
  const m = tail.exec(text);
  return m ? { at: start, m } : null;
}

/** What the last row's option, separator and value are made of, and the secret word its option ends in. */
const OPTION_PART_END = /[^A-Za-z0-9_.-]/;
const LIST_SEP_END = /[^\s,[-]/;
const ENDS_IN_SECRET_WORD = new RegExp(String.raw`${SECRET_OPTION_WORD}$`);
/** optionPairCan's searches, fresh for each run of steps (a paused generator shares no lastIndex). */
interface OptionPairEnds { readonly option: RegExp; readonly sep: RegExp; readonly value: { readonly '"': RegExp; readonly "'": RegExp } }
const optionPairEnds = (): OptionPairEnds => ({
  option: new RegExp(OPTION_PART_END.source, "g"),
  sep: new RegExp(LIST_SEP_END.source, "g"),
  value: { '"': /[\s"]/g, "'": /[\s']/g },
});

/**
 * Whether the last row can match at the quote at `at`, read as its regex is written: a SECRET_OPTION (letters,
 * digits, `_`, `.` and `-`, ending in its secret word) up to the same quote, LIST_SEP's characters (white space, `,`,
 * `[`, `-`) up to that quote again, and a value of three or more characters with no white space up to that quote once
 * more. Only what every match holds, so a place it turns down the regex fails at too, without the regex's own walk
 * back through a long option or value that never closes (40 to 50 ms over 4 MiB). Each look runs forward to the next
 * character that can't belong, once.
 */
function optionPairCan(text: string, at: number, ends: OptionPairEnds): boolean {
  const q = text[at] as '"' | "'";
  ends.option.lastIndex = at + 1;
  const optionEnd = ends.option.exec(text)?.index ?? -1;
  if (optionEnd < 0 || text[optionEnd] !== q || !ENDS_IN_SECRET_WORD.test(text.slice(Math.max(at + 1, optionEnd - 16), optionEnd))) return false;
  ends.sep.lastIndex = optionEnd + 1;
  const valueAt = ends.sep.exec(text)?.index ?? -1;
  if (valueAt < 0 || text[valueAt] !== q) return false;
  const value = ends.value[q];
  value.lastIndex = valueAt + 1;
  const valueEnd = value.exec(text)?.index ?? -1;
  return valueEnd >= 0 && text[valueEnd] === q && valueEnd - valueAt > 3;
}

/**
 * One row of LIST_PASSWORDS's global replace, the same bytes, tried only where a match can start and yielding every
 * LIST_STEP_MS. The row's own regex, sticky, is run on the whole text at each such place (for a program row, from its
 * name on: programAt), so its lookbehinds, its lookaheads and inMapping see exactly what the whole-text replace's do:
 * only where it is tried changes.
 * - A program row's match starts with listProgram: after a character of `[\s,["']` (or the text's start), an optional
 *   folder and then a name, all characters no LIST_DELIMITER is. So it starts at the first character of a run of such
 *   characters, the one run that holds a name of the row; the row is tried once per run that holds one (found case-blind,
 *   which holds every way anyCase writes it), at that run's start, never inside a match already taken.
 * - The last row's match starts at a quote followed by `-` (its SECRET_OPTION), so it is tried there.
 * Every place the whole-text replace could match is so tried, in the same order, so its matches are the same.
 */
function* listRowSteps(text: string, row: ListRow): Generator<void, string, void> {
  // A paused generator must not share lastIndex with another redaction (fresh regexes, as keyValueSteps).
  const sticky = new RegExp(row.tail ?? row.re.source, "y");
  const find = row.names === null ? new RegExp(OPTION_QUOTE.source, "g") : new RegExp(row.names, "gi");
  const ends = new RegExp(LIST_DELIMITER.source, "g");
  const pairEnds = optionPairEnds();
  const reach = row.names === null ? 2 : LIST_NAME_REACH;
  const chunks: string[] = [], pieces: string[] = [];
  let due = performance.now() + LIST_STEP_MS, tries = 0;
  let from = 0, taken = 0, outputAt = 0;
  while (from < text.length) {
    const windowEnd = Math.min(text.length, from + LIST_WINDOW);
    find.lastIndex = 0;
    const hit = find.exec(text.slice(from, windowEnd));
    if (!hit) {
      // A name cut by the window's end is whole in the next window, which starts within reach of it.
      from = windowEnd === text.length ? text.length : Math.max(from + 1, windowEnd - reach);
    } else {
      const at = from + hit.index;
      let start = at, next = at + 1;
      if (row.names !== null) {
        while (start > 0 && !isListDelimiter(text.charCodeAt(start - 1))) {
          start--;
          // A run can be the whole text: the scan back yields too.
          if ((start & 0xffff) === 0 && performance.now() >= due) { yield; due = performance.now() + LIST_STEP_MS; }
        }
        ends.lastIndex = at;
        const end = ends.exec(text);
        next = end ? end.index : text.length;
      }
      if (start >= taken) {
        let found: { at: number; m: RegExpExecArray } | null;
        if (row.names === null) {
          sticky.lastIndex = start;
          const m = optionPairCan(text, start, pairEnds) ? sticky.exec(text) : null;
          found = m && { at: start, m };
        } else found = programAt(text, start, next, sticky);
        if (found) {
          const folder = text.slice(start, found.at);
          const g = found.m.groups as { keep: string; value: string };
          const match = folder + found.m[0];
          pieces.push(text.slice(outputAt, start), listReplacement(match, start, text, { ...g, keep: folder + g.keep }));
          outputAt = taken = start + match.length;
          next = Math.max(next, taken);
          if (pieces.length >= 4096) { chunks.push(pieces.join("")); pieces.length = 0; }
        }
      }
      from = next;
    }
    if (++tries % LIST_CHECK === 0 || !hit) {
      if (performance.now() >= due) { yield; due = performance.now() + LIST_STEP_MS; }
    }
  }
  if (outputAt === 0) return text;
  pieces.push(text.slice(outputAt));
  chunks.push(pieces.join(""));
  return chunks.join("");
}

/** The whole-text form of a LIST_PASSWORDS row's pass, which listRowSteps must equal byte for byte. */
function listRowWhole(text: string, re: RegExp): string {
  return text.replace(re, (...m) => listReplacement(String(m[0]), m[m.length - 3] as number, m[m.length - 2] as string, m[m.length - 1] as { keep: string; value: string }));
}

/** A quoted list element or a bracket, for hideClientLists: a string's escapes taken as they come. */
const LIST_TOKEN = /[[\]()]|"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
/** Where a LIST_TOKEN can start. */
const LIST_TOKEN_START = /[[\]()"']/g;
const CLIENT_ELEMENT = new RegExp(String.raw`^(?:${CLIENT})(?:\.exe)?$`, "i");
const LIST_HOLDER_WHOLE = new RegExp(String.raw`^${LIST_HOLDER}$`);

/** Whether a list's element, inside the stack of lists that holds it, hides its value; and marks the list as a client's. */
function clientListElement(stack: boolean[], word: string): boolean {
  // The client as an element of its own, alone or with its folder, never an option's folder (`"-I/usr/include/mysql"`).
  if (!word.startsWith("-") && CLIENT_ELEMENT.test(word.split(/[\\/]/).at(-1) ?? "")) stack[stack.length - 1] = true;
  const value = word.slice(2);
  return stack[stack.length - 1] && word.startsWith("-p") && value !== "" && !/^[$%{<*[]/.test(value) && !LIST_HOLDER_WHOLE.test(value);
}

/**
 * MySQL's and MariaDB's attached `"-p…"` anywhere in a bracketed list that names the client, however many elements
 * stand between them (a 21-element list: memory-y7-1), past LIST_PASSWORDS's twelve. One scan of the text's quoted
 * elements and brackets with a stack of lists; never a bare `"-p"`, a variable, a template or a placeholder (as
 * listValue). The scan is LIST_TOKEN's matchAll (hideClientListsWhole) read by hand so it stays linear and yields
 * every LIST_STEP_MS: the regex, where a quote never closes, tries again at every later quote of its kind on that line,
 * and 128 KiB of `\"` took it 9 s. A quote that doesn't close fails where its string's characters stop (a line's end,
 * a `\` before one, or the text's); every later quote of its kind before there is one the failed string read as an
 * escaped character, so from it the string goes on in step with the failed one and fails there too: they are passed
 * over, as the regex would fail them, without reading the line again.
 */
function* clientListSteps(text: string): Generator<void, string, void> {
  if (!(yield* holds(text, "-p"))) return text;
  const starts = new RegExp(LIST_TOKEN_START.source, "g");
  const stack: boolean[] = [];
  const hide: [number, number][] = [];
  const failsBefore = { '"': -1, "'": -1 };
  let due = performance.now() + LIST_STEP_MS, tokens = 0;
  for (;;) {
    if (++tokens % LIST_CHECK === 0 && performance.now() >= due) { yield; due = performance.now() + LIST_STEP_MS; }
    const s = starts.exec(text);
    if (!s) break;
    const at = s.index, c = text[at];
    if (c !== '"' && c !== "'") {
      if (c === "[" || c === "(") stack.push(false);
      else stack.pop();
      continue;
    }
    const q = c as '"' | "'";
    if (at < failsBefore[q]) continue;
    let i = at + 1;
    for (let read = 0; ; read++) {
      // A string can be the whole text: its reading yields too.
      if ((read & 0xffff) === 0xffff && performance.now() >= due) { yield; due = performance.now() + LIST_STEP_MS; }
      if (i >= text.length) break;
      const ch = text.charCodeAt(i);
      if (ch === q.charCodeAt(0) || ch === 10) break;
      if (ch === 92) {
        // `\\.`: `.` takes no line terminator.
        const after = text.charCodeAt(i + 1);
        if (i + 1 >= text.length || after === 10 || after === 13 || after === 0x2028 || after === 0x2029) break;
        i += 2;
      } else i++;
    }
    if (text[i] !== q) {
      failsBefore[q] = i;
      starts.lastIndex = at + 1;
      continue;
    }
    starts.lastIndex = i + 1;
    if (stack.length === 0) continue;
    if (clientListElement(stack, text.slice(at + 1, i))) hide.push([at + 3, i]);
  }
  if (hide.length === 0) return text;
  // Joined a few thousand pieces at a time: 260,000 values hidden at once held the thread 60 ms.
  const chunks: string[] = [], pieces: string[] = [];
  let at = 0;
  for (const [from, to] of hide) {
    pieces.push(text.slice(at, from), SECRET_HIDDEN);
    at = to;
    if (pieces.length >= 4096) {
      chunks.push(pieces.join(""));
      pieces.length = 0;
      if (performance.now() >= due) { yield; due = performance.now() + LIST_STEP_MS; }
    }
  }
  pieces.push(text.slice(at));
  chunks.push(pieces.join(""));
  return chunks.join("");
}

/** hideClientLists's pass at once: the same bytes as hideClientListsWhole. */
function hideClientLists(text: string): string {
  return runSteps(clientListSteps(text));
}

/** hideClientLists as LIST_TOKEN's matchAll reads it, which clientListSteps must equal byte for byte (tests only:
 * quadratic where a quote never closes). */
function hideClientListsWhole(text: string): string {
  if (!text.includes("-p")) return text;
  const stack: boolean[] = [];
  const hide: [number, number][] = [];
  for (const m of text.matchAll(LIST_TOKEN)) {
    if (m[1] === undefined && m[2] === undefined) {
      if (m[0] === "[" || m[0] === "(") stack.push(false);
      else stack.pop();
      continue;
    }
    if (stack.length === 0) continue;
    if (clientListElement(stack, m[1] ?? m[2] ?? "")) hide.push([m.index + 3, m.index + m[0].length - 1]);
  }
  if (hide.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [from, to] of hide) { out += text.slice(at, from) + SECRET_HIDDEN; at = to; }
  return out + text.slice(at);
}

/** URL credentials: `://user:pass@` (and `://:pass@`, a password with no user: commands-remote-r10-6) becomes `://[secret hidden]@`. */
const URL_CREDENTIALS = /:\/\/[^/\s:@]*:[^/\s@]+@/g;

/**
 * Key-value pairs whose key names a secret: `password=…`, PHP's `'password' => …` and `$config['password'] = …`, `token: …`, `"api_key": "…"` (the value only). The key may
 * carry a prefix or suffix (`DB_PASSWORD`, `client_secret_id`); the value runs to whitespace, a quote, a comma or a
 * semicolon. A value that is already hidden is left alone. The match starts at the secret word (a prefix stays in the
 * text as it is) and the suffix is at most 256 characters, taken whole (a lookahead and its back-reference: none of its
 * characters can start the `=` or `:` after it, so giving any back never helps). That is a constant per start, so the
 * time stays linear: an open-ended class on either side made every start in a long run of letters rescan the whole
 * run, which froze Ember for minutes on one long token of output.
 */
export const KEY_VALUE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)(?=([A-Za-z0-9_.-]{0,256}))\2(?:["']\]|["'])?\s*(?:=>|=|:)\s*["']?)([^\s"',;]+)/gi;

/** The words a config's key ends in when its value is a secret, for CONFIG_PATTERNS (case is ignored where they're used). */
const CONFIG_SECRET = String.raw`(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)`;
/**
 * Passwords as common config formats write them, which KEY_VALUE's `key=value` and `key: value` miss
 * (commands-remote-r12-1); each keeps its first group and hides the value:
 * - PHP's `define('DB_PASSWORD', '…')` and WordPress's keys and salts (`AUTH_KEY`, `SECURE_AUTH_SALT`), never the
 *   sample's "put your unique phrase here";
 * - an XML element named for a secret (`<password>…</password>`, Maven's, FileZilla's `<Pass encoding="base64">`),
 *   never an empty one, a placeholder (`${env.PW}`) or a name that only holds the word (`<passage>`, `<compass>`);
 * - an XML `key` or `name` attribute that names a secret with its `value` (.NET's `<add key="Password" value="…"/>`);
 * - a line that is only `password X` or `Pass X` (msmtp, mbsync, fetchmail), never a sentence or Python's `pass`;
 * - a mail client's `smtp_pass = …`, `set imap_pass="…"`, offlineimap's `remotepass = …`, never `bypass` or `compass`
 *   or a filter's `low_pass`;
 * - a quoted password after the word (`with password '…'`, fetchmail's);
 * - curl's and wget's `user = name:password` in their settings files, and `--user name:password` on a line of its own;
 * - Subversion's cached login, the `V n` value after a `K n` / `password` key.
 * - Redis's, OpenLDAP's and nslcd's password lines, a Wi-Fi key, an ini's bare `pass = X` and s-nail's `set password-…=`.
 * Each look is bounded, so a long run of output stays linear.
 */
const CONFIG_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`(\bdefine\s{0,8}\(\s{0,8}(["'])[A-Za-z0-9_]{0,64}?(?:${CONFIG_SECRET}|pass|key|salt)\2\s{0,8},\s{0,8}(["']))(?![$%{<*[])(?!put your unique phrase)(?:(?!\3)[^\n\\]){1,1000}(?=\3)`, "gi"),
  new RegExp(String.raw`(<(?:[A-Za-z0-9_.:-]{0,64}?${CONFIG_SECRET}|(?:[A-Za-z0-9_.:-]{0,64}[_.:-])?pass)(?:\s[^<>]{0,200})?>)(?![$%{*\s])[^<]{1,2000}(?=<\/)`, "gi"),
  new RegExp(String.raw`(<[A-Za-z][\w.:-]{0,64}\s(?:[^<>]{0,200}?\s)?(?:key|name)\s{0,8}=\s{0,8}(["'])[\w.:-]{0,64}?(?:${CONFIG_SECRET}|pass)\2(?:\s[^<>]{0,200}?)?\svalue\s{0,8}=\s{0,8}(["']))(?![$%{*])(?:(?!\3)[^<>\n]){1,1000}(?=\3)`, "gi"),
  /((?:^|\n)[ \t]*(?:password|Password|PASSWORD|passwd|pass|Pass|PASS)[ \t]+)(?![$%{<*[#])(?:"[^"\n]+"|'[^'\n]+'|[^\s"']+)(?=[ \t]*(?:\r?\n|$))/g,
  new RegExp(String.raw`((?:^|\n)[ \t]*(?:set[ \t]+)?(?![\w.-]{0,64}?(?:low|high|band|all|render)[_.-]pass\b)(?:[A-Za-z0-9_.-]{0,64}[_.-]|remote|local)(?:pass|pw)[ \t]*[=:][ \t]*["']?)(?![$%{<*[])[^\s"',;]+`, "gi"),
  /(\b(?:password|passwd)[ \t]+(["']))(?![$%{<*[])(?:(?!\2)[^\n]){1,256}(?=\2)/gi,
  /((?:^|\n)[ \t]*(?:--?)?(?:proxy-)?user[ \t]*(?:=|:|[ \t])[ \t]*["']?[^\s"':]+:)(?![$%{<*[])[^\s"']+/g,
  // Subversion's cached login, a K/V record: the V line after a `password` key (r12-commands-x12-8).
  /((?:^|\n)K[ \t]\d{1,4}\r?\n(?:password|passphrase)\r?\nV[ \t]\d{1,6}\r?\n)[^\r\n]+/g,
  // Redis's, OpenLDAP's and nslcd's password lines (`requirepass X`, `masterauth X`, `rootpw X`, `bindpw X`) and a
  // `PassPhrase X`, also as grep -n numbers them (`507:requirepass X`); a Wi-Fi key (`psk=X`, wpa_supplicant's
  // `psk="X"`, hostapd's `wpa_psk=X`); an ini's bare `pass = X` (rclone, ZNC's `Pass = plain#X`); s-nail's `set
  // password-user@host=X` (r12-commands-y12-4).
  /((?:^|\n)[ \t]*(?:\d{1,9}[:-])?(?:requirepass|masterauth|rootpw|bind_?pw|passphrase)[ \t]+)(?![$%<*[#]|\{\{)(?:"[^"\n]+"|'[^'\n]+'|[^\s"']+)/gi,
  /((?:^|\n)[ \t]*(?:\d{1,9}[:-])?(?:wpa_)?psk[ \t]*=[ \t]*"?)(?![$%{<*[])[^\s"]+/gi,
  /((?:^|\n)[ \t]*(?:\d{1,9}[:-])?pass[ \t]*=[ \t]*["']?)(?![$%{<*[])[^\s"',;]+/gi,
  /((?:^|\n)[ \t]*(?:\d{1,9}[:-])?set[ \t]+password-[^\s=]{1,256}=["']?)(?![$%{<*[])[^\s"']+/gi,
];

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
 * A pass can match across lines (a private key block, a list's `\n- ` separator), so only KEY_VALUE (keyValueSteps,
 * integ-x-3) and the argument-list passes (listRowSteps, clientListSteps: one row took 645 ms over 4 MiB on CI's
 * Windows runner) run in steps of their own, never on slices of the text; a caller
 * that must keep Ember's main thread free between passes runs them one at a time (redactSecretsYielding) and gets the
 * same bytes, since it is the same list (merge review integ-y-2).
 */
/** A LIST_PASSWORDS row's steps, guarded as MYSQL_PASSWORD is where `guarded` (LIST_MYSQL needs a `-p`). */
const listSteps = (row: ListRow, guarded: boolean) => function* (t: string): Generator<void, string, void> {
  return guarded && row.re === LIST_MYSQL && !(yield* holds(t, "-p")) ? t : yield* listRowSteps(t, row);
};
const LIST_ROW_STEPS = LIST_ROWS.map(row => listSteps(row, true));
/** The list passes, each at once (runSteps over its steps, which redactSteps runs a step at a time: PASS_STEPS). */
const LIST_PASSES: readonly ((text: string) => string)[] = LIST_ROW_STEPS.map(steps => (t: string) => runSteps(steps(t)));
const UNGUARDED_LIST_PASSES: readonly ((text: string) => string)[] = LIST_ROWS.map(row => listSteps(row, false)).map(steps => (t: string) => runSteps(steps(t)));

/**
 * The argument-list passes of REDACT_PASSES (LIST_PASSWORDS's rows, then hideClientLists): as REDACT_PASSES holds
 * them, as steps in the same order, and the whole-text forms (each row's plain global replace, with no `-p` guard)
 * they must equal byte for byte (commands-redact-argv.test.ts).
 */
export const LIST_PASSES_AT_ONCE: readonly ((text: string) => string)[] = [...LIST_PASSES, hideClientLists];
export const LIST_PASS_STEPS: readonly ((text: string) => Generator<void, string, void>)[] = [...LIST_ROW_STEPS, clientListSteps];
export const LIST_PASSES_WHOLE: readonly ((text: string) => string)[] = [
  ...LIST_PASSWORDS.map(re => (t: string) => listRowWhole(t, re)),
  hideClientListsWhole,
];

const passes = (guarded: boolean): readonly ((text: string) => string)[] => [
  ...TOKEN_PATTERNS.map(re => (re === PRIVATE_KEY ? hidePrivateKeys : (t: string) => t.replace(re, SECRET_HIDDEN))),
  ...VALUE_PATTERNS.map(re => (t: string) => (guarded && !(VALUE_NEEDS.get(re) ?? []).every(n => t.includes(n)) ? t : t.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN))),
  ...OPTION_PASSWORDS.map(re => (t: string) => (guarded && re === MYSQL_PASSWORD && !t.includes("-p") ? t : t.replace(re, (_m, keep: string, quote: string, _value: string, after?: string) => `${keep}${quote}${SECRET_HIDDEN}${quote}${typeof after === "string" ? after : ""}`))),
  ...(guarded ? LIST_PASSES : UNGUARDED_LIST_PASSES),
  hideClientLists,
  ...CONFIG_PATTERNS.map(re => (t: string) => t.replace(re, (_m, keep: string) => keep + SECRET_HIDDEN)),
  t => t.replace(URL_CREDENTIALS, `://${SECRET_HIDDEN}@`),
  hideKeyValues,
];
/** redactSecrets's passes (above), with necessary-text checks before Azure, environment assignment and MySQL searches. */
export const REDACT_PASSES: readonly ((text: string) => string)[] = passes(true);
/** The same passes without necessary-text checks: what REDACT_PASSES must equal byte for byte (commands-redact.test.ts). */
export const UNGUARDED_PASSES: readonly ((text: string) => string)[] = passes(false);

/**
 * redactSecrets as steps: a step before each of REDACT_PASSES, so a caller can let other work run between them
 * (output.ts cleanOutputAsync). Nothing but this generator holds the text between steps.
 */
export function* redactSteps(text: string): Generator<void, string, void> {
  let out = text;
  for (const pass of REDACT_PASSES) {
    yield;
    const steps = PASS_STEPS.get(pass);
    out = steps ? yield* steps(out) : pass(out);
  }
  return out;
}

/** The passes of REDACT_PASSES that run as steps of their own, by the pass: their at-once form is runSteps over them. */
const PASS_STEPS: ReadonlyMap<(text: string) => string, (text: string) => Generator<void, string, void>> = new Map([
  ...LIST_PASSES.map((pass, i) => [pass, LIST_ROW_STEPS[i]] as const),
  [hideClientLists, clientListSteps] as const,
  [hideKeyValues, (t: string) => keyValueSteps(t)] as const,
]);

/** KEY_VALUE's pass at once: the same bytes as its whole-text replace (keyValueSteps). */
function hideKeyValues(text: string): string {
  return runSteps(keyValueSteps(text));
}

/** The work between key-value steps (integ-x-3: one whole 4 MiB regex pass held Ember's main thread 358 ms,
 * longer than Stop's 300 ms). Search, whitespace, values, output and bounded regex searches all count. */
export const KEY_VALUE_SLICE = 256 * 1024;
/** How far before its `=` or `:` (and the spaces before it) a KEY_VALUE match can start: the secret word (at most 13),
 * its suffix (at most 256) and a quote and a bracket, with room to spare. */
const KEY_REACH = 300;
const KEY_SPACE = /\s/;
const KEY_VALUE_CHAR = /[^\s"',;]/;
const KEY_NAME_CHAR = /[A-Za-z0-9_.-]/;
const KEY_NAME = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)/i;
const KEY_NAME_MAX = 13;

/**
 * The exact whole-text KEY_VALUE replacement, with bounded work between yields. Every match has an operator and a
 * key within KEY_REACH of its preceding whitespace. At each operator, the unchanged regex sees only that bounded
 * prefix, the actual delimiter, one representative of its following \s* run, an optional quote and the first value
 * character. Nothing else in the regex depends on those whitespace runs or the rest of the value. Original offsets
 * supply all output; a separate consumed floor preserves global-regex non-overlap even for already-hidden values.
 * Unlike delimiter-based cuts, this also yields when no safe cut exists in a multi-megabyte merged span.
 */
export function* keyValueSteps(text: string, slice = KEY_VALUE_SLICE): Generator<void, string, void> {
  // No KEY_VALUE match can exist without one whole secret name. Overlap retains names across scan boundaries;
  // bounded scans yield even for plain JSON with hundreds of thousands of non-secret ':' operators.
  const stride = Number.isFinite(slice) && slice > 0 ? Math.max(1, Math.min(KEY_VALUE_SLICE, Math.floor(slice))) : KEY_VALUE_SLICE;
  let named = false;
  for (let from = 0; from < text.length; from += stride) {
    named = KEY_NAME.test(text.slice(from, from + stride + KEY_NAME_MAX - 1));
    if (from + stride < text.length) yield;
    if (named) break;
  }
  if (!named) return text;
  // A paused generator must not share lastIndex with another redaction or the public whole-text regex.
  const re = new RegExp(KEY_VALUE.source, KEY_VALUE.flags);
  const chunks: string[] = [], pieces: string[] = [];
  const flush = (): void => {
    if (pieces.length) {
      chunks.push(pieces.join(""));
      pieces.length = 0;
    }
  };
  let outputAt = 0, consumed = 0, cursor = 0, previous = -1, work = 0;
  while (cursor < text.length) {
    while (cursor < text.length && text[cursor] !== "=" && text[cursor] !== ":") {
      cursor++;
      if (++work >= slice) { work = 0; flush(); yield; }
    }
    if (cursor === text.length) break;
    const operator = cursor;
    let before = operator;
    while (before > consumed && KEY_SPACE.test(text[before - 1])) {
      before--;
      if (++work >= slice) { work = 0; flush(); yield; }
    }
    // Key/suffix/quote syntax cannot cross a prior operator. KEY_VALUE has no left-context assertion, so clipping
    // before its maximum possible key reach cannot introduce a match at an artificial boundary.
    const start = Math.max(consumed, previous + 1, before - KEY_REACH);
    // Only the trailing ASCII key run, before an optional quote/bracket, can contain this operator's secret name.
    // An older URL's /secrets/ elsewhere in the prefix says nothing about the current `https:` or `"value":` key.
    // This is only a necessary check; KEY_VALUE still decides every match with its original suffix and case rules.
    let nameEnd = before;
    const lastKeyChar = text[nameEnd - 1];
    if (nameEnd - start >= 2 && lastKeyChar === "]" && (text[nameEnd - 2] === '"' || text[nameEnd - 2] === "'")) nameEnd -= 2;
    else if (nameEnd > start && (lastKeyChar === '"' || lastKeyChar === "'")) nameEnd--;
    let nameStart = nameEnd;
    while (nameStart > start && KEY_NAME_CHAR.test(text[nameStart - 1])) {
      nameStart--;
      if (++work >= slice) { work = 0; flush(); yield; }
    }
    const possibleName = KEY_NAME.test(text.slice(nameStart, nameEnd));
    work += (nameEnd - nameStart) * KEY_REACH;
    if (!possibleName) {
      cursor = operator + 1;
      previous = operator;
      if (work >= slice) { work = 0; flush(); yield; }
      continue;
    }
    const prefix = text.slice(start, before);
    const arrow = text[operator] === "=" && text[operator + 1] === ">";
    let valueAt = operator + (arrow ? 2 : 1);
    let tail = text.slice(operator, valueAt);
    const spaces = valueAt;
    while (valueAt < text.length && KEY_SPACE.test(text[valueAt])) {
      valueAt++;
      if (++work >= slice) { work = 0; flush(); yield; }
    }
    if (valueAt > spaces) tail += " ";
    if (text[valueAt] === '"' || text[valueAt] === "'") tail += text[valueAt++];
    if (valueAt < text.length) tail += text[valueAt];
    const candidate = prefix + tail;
    re.lastIndex = 0;
    const match = re.exec(candidate);
    // Each bounded search can try every prefix position and its bounded suffix. Charge that work as well as scans.
    work += candidate.length * KEY_REACH;
    if (match && match.index + match[1].search(/[=:]/) === prefix.length) {
      // If => has no valid following value, the original regex backtracks to '=' with '>' as its value.
      const valueStart = arrow && match.index + match[1].length === prefix.length + 1 ? operator + 1 : valueAt;
      let end = valueStart;
      while (end < text.length && KEY_VALUE_CHAR.test(text[end])) {
        end++;
        if (++work >= slice) { work = 0; flush(); yield; }
      }
      consumed = end;
      if (!text.startsWith("[secret", valueStart)) {
        while (outputAt < valueStart) {
          const to = Math.min(valueStart, outputAt + KEY_VALUE_SLICE);
          pieces.push(text.slice(outputAt, to));
          work += to - outputAt;
          outputAt = to;
          if (work >= slice) { work = 0; flush(); yield; }
        }
        pieces.push(SECRET_HIDDEN);
        outputAt = end;
        work += SECRET_HIDDEN.length;
      }
      cursor = end;
    } else cursor = operator + 1;
    previous = operator;
    if (work >= slice) { work = 0; flush(); yield; }
  }
  if (!chunks.length && !pieces.length) return text;
  while (outputAt < text.length) {
    const to = Math.min(text.length, outputAt + KEY_VALUE_SLICE);
    pieces.push(text.slice(outputAt, to));
    work += to - outputAt;
    outputAt = to;
    if (work >= slice) { work = 0; flush(); yield; }
  }
  flush();
  return chunks.join("");
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
