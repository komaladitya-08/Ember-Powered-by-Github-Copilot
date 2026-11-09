/**
 * What Ember's memory never keeps. A fact is refused whole, never stored redacted, when it holds a secret: a token or
 * key (the commands redactor's patterns, commands/redact.ts), a card number, an IBAN or a social security number, or
 * words that say a password, PIN or code follows, however they are put ("the password for the HR portal is…", "VPN
 * password hunter2", "the door code is 4821"). Memory outlives the conversation, so a secret kept there would outlive
 * it too (CLAUDE.md: password text never reaches the model; the memory note promises Ember never keeps passwords,
 * codes or card numbers). Best effort, as the redactor is: what it never does is keep what it noticed.
 */

import { redactSecrets } from "../commands/redact";

/**
 * Words that say no value follows only with more words after them in the clause, none with a digit or a symbol
 * ("Password: never logged", "password: hashed with bcrypt", "The pin of a tool: its name, description…"; "its" before
 * two words at least), since a slip for "it's" or a value after one is written the same way ("Wi-Fi password is its
 * BlueSky99", "Password for Gmail is never Summer2024!", "password: its fluffy"): memory-v5-1. "typed", "entered", "hashed"
 * and "masked" say it at the clause's end too ("Passwords are hashed.", "Password: Masked", "Password: hashed (bcrypt)"),
 * but not before brackets with a value-shaped word in them ("PIN: entered (4821)"): memory-w5-3.
 */
const CLAUSE_WORD = String.raw`[ \t]+[A-Za-z][A-Za-z'’-]*(?![\w!@#$%^&*])`;
const CLAUSE_END = String.raw`[^\d!@#$%^&*\n.;]{0,80}(?:[\n.;]|$)`;
const STATE_END = String.raw`[ \t]*(?:[.,;:!?)\n]|$|\((?![^)\n]*(?:\d{3}|[A-Za-z]\d|\d[A-Za-z]|[!@#$%^&])))`;
const BEFORE_WORDS = String.raw`its(?=${CLAUSE_WORD}[ \t,]*${CLAUSE_WORD}${CLAUSE_END})|never(?=${CLAUSE_WORD}${CLAUSE_END})`
  + String.raw`|(?:typed|entered|hashed|masked)(?=${CLAUSE_WORD}${CLAUSE_END}|${STATE_END})`;
/**
 * Words that follow a secret's name without being its value ("the password is required", "PIN: the tab is pinned",
 * "Password: changed yesterday"): a value is anything else ("hunter2", "correct-horse"). A Wi-Fi key's state is no
 * value only after a Wi-Fi key's name (withoutKeyStates).
 */
const NOT_A_VALUE = [
  "the", "a", "an", "my", "your", "our", "their", "his", "her", "this", "that", "it", "not", "no", "now", "being", "been", "changed",
  "required", "needed", "reset", "set", "saved", "stored", "updated", "expired", "protected", "managed", "forgotten", "wrong", "strong",
  "weak", "pinned", "hidden", "secret", "private", "in", "on", "at", "for", "to", "from", "with", "by", "of", "and", "or", "same",
  "different", "unchanged", "missing", "incorrect", "invalid", "valid", "too", "very", "also", "still", "fine", "empty", "blank", "none",
  "shown", "visible", "encrypted", "optional", "case-sensitive", "long", "short", "below", "above", "here", "there",
  "done", "due", "expiring", "broken", "working", "ok", "okay", "complete", "temporary", "known", "unknown", "shared", "sent",
  "printed", "written", "listed", "attached", "included", "strict", "changing", "same", BEFORE_WORDS,
].join("|");

/**
 * A secret's name with one of those words where its value would be ("Password: changed yesterday"): taken out before
 * the redactor looks, which would otherwise take "changed" for the password.
 */
const NAMED_NO_VALUE = new RegExp(
  String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*(?:=|:)\s*["']?(?:${NOT_A_VALUE})(?=[\s.,;!?"']|$)`,
  "gi",
);

/**
 * Code where a secret's value would be (memory-r4-1, memory-r4-2): Projects' files and requests, a patch's text and a
 * task's view share this guard, and code names tokens and passwords all the time. A key or a variable named like a
 * secret ("token", "max_tokens", "self.password", "apiKey", "creds", "pin") is passed over when what follows its ":" or
 * "=" is code, not a value: a type ("token: string", "password: str"), a call, a member or an index ("text.split()",
 * "process.env.GITHUB_TOKEN", "os.environ[…]"), a reference or a template ("${{ secrets.X }}", "$TOKEN"), a placeholder
 * ("...", "<your-key>"), a keyword, a literal or a collection ("await", "None", "[]"), a variable that names a secret
 * or the same name ("password = password", "creds = creds_v2"), a count after a name for one ("max_tokens=256"), an
 * arrow or a property's comparison ("token => …", "token.type === …"), and code on the next line ("refresh_token:\n
 * creds.refresh(…)"). Only the name is written out, so a token in the value is still found; a quoted value, a bare word,
 * a value with a digit or a symbol and a PIN's number stay values (fail closed), and so does code that holds a literal
 * as a default, a getenv default or one shaped like a password ("os.getenv('PW', 'hunter2')", "pw || 'Summer2024!'").
 */
const KEY_BEFORE_SEP = /(?<![\w$-])(?<![\w$.-]\.)[A-Za-z_$][\w$.-]{0,127}(?=["']?\s{0,40}[:=])/g;
/** The words in a key's name that say a secret, as the redactor's KEY_VALUE and this guard's own names read them. */
const SECRET_IN_NAME = /pass(?:word|wd|phrase|code)?|pwd|pw|secret|token|key|credentials?|creds|login|pin|otp|cvv|cvc|puk|psk|wi-?fi/i;
/**
 * Words that hold a secret's name but never name one ("tokenizer", "keyboard", "passport", "bypass"), so
 * `tokenizer: "cl100k_base"` is a setting (integrations-r4-1).
 */
const NOT_SECRET_WORD = /^(?:de)?tokeni[sz](?:er|ers|ed|es|e|ing|ation)$|^(?:keyboard|keyboards|keyframes?|keymaps?|keycodes?|keypress|keydown|keyup|keystrokes?|monkey|passport|compass|bypass|passenger|spinner|pinterest|pinyin|pinned|pinch)$/i;
/** A variable's own words that name a secret, so "accessToken", "creds_v2" and "SECRET_KEY" are variables, not values. */
const SECRET_PARTS = new Set(["password", "passwords", "passwd", "pwd", "pw", "pass", "passphrase", "passcode", "secret", "secrets", "token",
  "tokens", "key", "keys", "apikey", "cred", "creds", "credential", "credentials", "login", "auth", "pin"]);
/**
 * A key's words that make a number after it a count or a limit ("max_tokens", "token_count", "PASSWORD_MIN_LENGTH"),
 * and "tokens" after another word ("prompt_tokens"), never a bare plural ("pins: 4821", "Passwords: 48213377"): memory-v5-3.
 */
const COUNT_PARTS = /^(?:max|min|count|counts|num|number|limit|limits|len|length|size|total|budget|used|remaining|left|ttl|timeout|expiry|expires|expiration|age|lifetime|life|retries|retry|attempts|tries|history|rounds|cost|bits|bytes|chars|digits|offset|index|idx|pos|position|width|height|depth|level|version|ms|sec|secs|seconds|minutes|hours|days|interval|delay|window|rate|per|cache|buf|buffer)$/i;
/** A key's words for a PIN or a card's code, whose number is its value however short ("pin = 4821", "cvv: 123"). */
const PIN_PARTS = /^(?:pin|pins|passcode|otp|cvv|cvv2|cvc|cvc2|puk|code)$/i;
/** A property that holds the secret itself ("password.value = …"). */
const VALUE_PROPERTY = /^(?:value|val|text|raw|data|content|plain|plaintext|str|string|hash|secret|key)$/i;
/**
 * A property that says what a secret is or where it stands, never what it is ("token.type", "tokens.length",
 * "password.minLength", "token.start"): a literal after it is a value only when shaped like a secret, and a number is
 * never one. Any other property names one of several ("secrets.db", "passwords.home", "password.old", "token.prod"),
 * whose literal is that secret (safety-privacy-r5-1).
 */
const ABOUT_PROPERTY = /^(?:types?|kinds?|name|label|id|length|size|count|min|max|minlength|maxlength|pattern|regex|format|required|optional|enabled|disabled|expires|expiry|expiresat|expiresin|ttl|scopes?|audience|issuer|alg|algorithm|header|prefix|field|placeholder|start|end|pos|loc|line|lineno|column|col|range|offset|index|parent|next|prev|previous|children|flags|mode|state|status|errors?|message|msg|valid|visible|hidden|readonly|autocomplete|tag|tags|precedence|depth|level|group|category|role|class|classname|style|width|height|lines|cols|rows|row|file|path|dir|folder|url|uri|location|store|source|env|ref|provider|backend|policy|rules?|strength|prompt|reset|manager|field|input)$/i;
/** Objects whose members are read in code ("config.creds2", "os.environ", "self.token"). */
const CODE_OBJECTS = new Set(["self", "this", "cls", "super", "process", "os", "sys", "env", "environ", "config", "conf", "cfg", "settings",
  "options", "opts", "props", "state", "ctx", "context", "req", "request", "res", "response", "args", "argv", "params", "kwargs", "data", "form",
  "body", "headers", "session", "app", "window", "document", "globalthis", "global", "module", "exports", "vault", "secrets", "auth", "user",
  "account", "client", "api", "db", "store", "import", "credentials", "creds", "keys"]);
/**
 * What comes after a name or a type in code, never more words: the end, a closing bracket, a comma, a semicolon, an
 * operator or a comment ("token: string)", "pw || 'x'", "creds_v2 # old"), so "PIN: number 4821" and "Password: if
 * anyone asks, BlueSky99" stay values.
 */
const CODE_AFTER = String.raw`(?=\s*(?:$|[),;\]}|&?:=<>{[]|\/\/|#|->|\.\.\.|\+\s|\*\s|%\s|\?\s|!=))`;
/** A type where a value would be ("token: string", "password: str", "secret: unique symbol;", "pin: number)"). */
const CODE_TYPE = new RegExp(String.raw`^(?:string|str|number|int|integer|float|double|decimal|bool|boolean|bytes|bytearray|any|unknown|object|never|void|symbol|bigint|char|byte|long|short|unsigned|uint\d*|int\d*|u8|u16|u32|u64|i8|i16|i32|i64|usize|isize|unique\s+symbol)(?![\w$])${CODE_AFTER}`, "i");
/**
 * A keyword or a literal where a value would be, as code writes it ("await getToken()", "new Map()", "None,", "true;"):
 * "new" only before a call or a generic, and "self." only before a member with no digit, never "new Summer2024!" or
 * "self.made99" (memory-v5-3).
 */
const CODE_WORD = new RegExp(String.raw`^(?:(?:new|await|yield|typeof|keyof|readonly)\s+[A-Za-z_$][\w$.]*[(<]|(?:async|function)\s*[(*]|(?:async|function|lambda)\s+[A-Za-z_$][\w$]*\s*[(:]|(?:require|import)\s*\(|(?:this|self|super|cls)\.(?![\w$.]*\d)|(?:true|false|True|False|null|NULL|None|nil|undefined|NaN|void\s+0)(?![\w$@!#%&*.-])${CODE_AFTER})`);
/** A statement where a block's first line would be, after a key that ends its line ("if creds.refresh_token:\n  if …"). */
const CODE_STATEMENT = /^(?:if|elif|else|for|while|return|raise|throw|try|except|finally|with|def|class|pass|break|continue|print|assert|del|case|default|const|let|var|static|import|from|yield|await)\b/;
/** A Python block's own line, which ends with the key's ":" ("if not tokens:", "elif volume.secret:", "class Token:"). */
const PY_BLOCK = /^\s*(?:if|elif|while|for|with|def|class|async\s+(?:def|for|with))\s[^\n]*:\s*$/;
/** A Python statement, which a block's body opens with ("return \"\"", "yield token.kind, token.value"). */
const PY_STATEMENT = /^(?:return|yield|raise|pass|break|continue|if|for|while|with|try|del|assert|print|import|from|await|global|nonlocal|def|class|async)\b/;
/**
 * Whether `s`, a block's first line, is a statement written as code: one that ends as a block's or a call's line does,
 * or a keyword alone or before one name or call ("return creds", "pass"), never "default is admin123" (memory-v5-3).
 */
const codeStatement = (s: string) => CODE_STATEMENT.test(s)
  && (/[:({;)[\]]\s*$/.test(s) || /^[a-z]+(?:\s+[A-Za-z_$][\w$.]*(?:\([^()]*\))?)?$/.test(s));
/** A placeholder for a secret, never one ("...", "sk-...", "xxxx", "****", "<your-token>", "YOUR_API_KEY", "[redacted]"). */
const PLACEHOLDER = /^(?:\.{3}|…|\w{0,6}[-_](?:\.{3}|…)|x{3,}(?:[-_]x+)*|\*{3,}|<[^<>\d]*>|\[[^\]\d]*\]|your[-_][\w-]+|(?:Bearer|Basic|token)\s+(?:\.{3}|…|x{3,}|<[^<>\d]*>|\$\{[^}]*\}|\$\w+))$/i;
/**
 * A placeholder in brackets where a value would be, unquoted: capitals or a word that says so ("<your-token>", "[redacted]",
 * "<TOKEN>"), never a word of its own ("[BlueSky]", "<fluffy>"): memory-v5-3.
 */
const BRACKET_HOLDER = /^(?:<[^<>[\]\d]*(?:redact|hidden|removed|omitted|secret|pass|pwd|token|key|value|placeholder|here|your|example|sample|insert|enter|replace)[^<>[\]\d]*>|\[[^<>[\]\d]*(?:redact|hidden|removed|omitted|secret|pass|pwd|token|key|value|placeholder|here|your|example|sample|insert|enter|replace)[^<>[\]\d]*\])$/i;
const BRACKET_CAPS = /^(?:<[A-Z][A-Z_ -]*>|\[[A-Z][A-Z_ -]*\]|<>|\[\])$/;
/** A reference to where the secret is kept, or a template ("${{ secrets.X }}", "$(gh auth token)", "$TOKEN", "%TOKEN%"). */
const REFERENCE = /^(?:\$\{|\$\(|\{\{|\{%|<%|env:|\$[A-Z_][A-Z0-9_]*(?![\w$])|%[A-Z_][A-Z0-9_]*%)/;
/** A version ("^8.0.2", "v2.0", "1.x"), never a secret. */
const VERSION = /^(?:[~^<>=]*v?\d+(?:\.(?:\d+|x|\*))+(?:[-+][\w.]+)?|\*|latest|workspace:\S*)$/i;

/** Whether `s`, a quoted literal in code, is shaped like a password or a token rather than a name, a path or a version. */
function secretShaped(s: string): boolean {
  if (s.length < 6 || /\s/.test(s)) return false;
  // An address, an email, a path, a file, a host and port, a version, a constant's or an algorithm's name, a colour, or
  // lowercase words joined ("bert-base-uncased", "gpt-4o", "us-east-1").
  if (/:\/\/|[\\/]|^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$|^[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,4}$|^[\w.-]+:\d{2,5}$|^#[0-9a-f]{3,8}$/i.test(s)) return false;
  if (VERSION.test(s) || /^[A-Z][A-Z0-9_]*$/.test(s) || /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(s)) return false;
  if (/^(?:sha|md|hs|rs|es|ps|base|utf|u?int|float|crc|aes|blake|x)\d+(?:url|le|be)?$/i.test(s)) return false;
  return /[!@%^&*~]/.test(s) || (/[A-Za-z]/.test(s) && /\d/.test(s));
}

/**
 * The quoted literals in `v`'s expression, up to a ";" or a line's end, or a "," or a closing bracket outside any it
 * opened, each with the expression's text before it and how many brackets it is inside.
 */
function literalsIn(v: string): { s: string; before: string; depth: number }[] {
  const out: { s: string; before: string; depth: number }[] = [];
  let depth = 0;
  for (let i = 0; i < v.length && i < 240; i++) {
    const c = v[i]!;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < v.length && v[j] !== c && v[j] !== "\n") j += v[j] === "\\" ? 2 : 1;
      out.push({ s: v.slice(i + 1, j), before: v.slice(0, i), depth });
      i = j;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (--depth < 0) break; }
    else if (c === ";" || c === "\n" || (c === "," && depth === 0)) break;
  }
  return out;
}

/**
 * Whether a literal in code may be the secret itself: shaped like one, or given as a default or an initial value
 * ("pw || 'changeme'", "?? 'abc'", "str = 'x'", "os.getenv('PW', 'x')", "${PW:-x}"), never a call's named argument
 * ("expect(…, expected='a name')") or a space ("tokens.length ? ' ' : ''").
 */
function holdsLiteral(v: string): boolean {
  // A shell default ("${PW:-hunter2}") or a command that prints its own words ("$(echo hunter2)").
  if (/\$\{[^}\n:=-]{0,80}:?[-=](?!\})[^}\n]{1,80}\}|\$\(\s*(?:echo|printf|print)\b/.test(v)) return true;
  return literalsIn(v).some(({ s, before, depth }) => /\w/.test(s) && !PLACEHOLDER.test(s) && !REFERENCE.test(s)
    && (secretShaped(s) || /(?:\|\||\?\?|\?:|\bor|\?|:-)\s*$/.test(before) || (depth === 0 && /(?<![=!<>])=\s*$/.test(before))
      || /\b(?:getenv|get|getattr|setdefault|getProperty|GetEnvironmentVariable|default|fallback)\s*\([^()]*,\s*$/i.test(before)));
}

/** A variable's words: "max_tokens" → max, tokens; "accessKeyId" → access, Key, Id; "SECRET_KEY" → SECRET, KEY. */
const words = (name: string) => name.split(/[_$-]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);

/** Whether `id`, a bare identifier, is a variable that names a secret ("accessToken", "creds_v2", "SECRET_KEY", "key"). */
function namesSecret(id: string): boolean {
  // Capitalised words with digits ("Password_1", "Secret2024") are how passwords are written, and a long run of letters
  // and digits may be a token.
  if (/^[A-Z][a-z]+_?\d/.test(id) || (/^[A-Za-z0-9]{12,}$/.test(id) && /\d/.test(id))) return false;
  return words(id).some(w => SECRET_PARTS.has(w.toLowerCase()));
}

/** Whether a member chain ("process.env.GITHUB_TOKEN", "config.creds2", "s.tokens", "ts.Node") reads as code. */
function codeMember(chain: string): boolean {
  const parts = chain.split(/\??\./);
  return CODE_OBJECTS.has(parts[0]!.toLowerCase()) || parts.some(p => SECRET_IN_NAME.test(p) || /[_$]|[a-z][A-Z]|^[A-Z]{2,}$|[A-Z]{2}[a-z]/.test(p))
    || (/^[a-z]/.test(parts[0]!) && parts.slice(1).some(p => /^[A-Z]/.test(p)));
}

/** A line of code by how it starts or ends ("const …", "export declare …", "def …", "… {"): a bare name in it is a variable. */
const CODE_LINE = /^\s*(?:export|declare|const|let|var|val|final|readonly|private|public|protected|static|abstract|override|async|function|def|fn|func|interface|class|struct|enum|return|yield|await)\s|[{(]\s*$/;
/**
 * What stands before a shell's variable on its line: export, readonly, declare or typeset and their flags, local or a
 * Dockerfile's ENV, perhaps with other variables set after it, or, for a name in capitals, nothing but other variables
 * in capitals ("DB_USER=app DB_PASSWORD=x ./start"): memory-v5-2. Never a call's or a signature's arguments
 * ("host=host, password=password", "oldToken=None):"): memory-w5-1.
 */
const SHELL_BEFORE = /^\s*(?:(?:export|readonly|declare|typeset|local)(?:\s+-[A-Za-z]+)*\s+|ENV\s+)(?:[A-Za-z_]\w*=\S*\s+)*$/;
const SHELL_CAPS_BEFORE = /^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*$/;
/** A shell's reference or switch where its value would be ("local password=$2", "TOKEN=$token", "USE_TOKEN=false"): memory-w5-1. */
const SHELL_CODE = /^(?:\$(?:\d|[@*#?]|[A-Za-z_]+)|true|false|yes|no|null|none)(?![\w$@.!#%&*-])/i;
/** A TypeScript type ("type CommentOrToken = Comment | Token;"), which never holds a value. */
const TYPE_ALIAS = /^\s*(?:export\s+)?(?:declare\s+)?type\s+[A-Za-z_$][\w$]*(?:<[^=\n]*>)?\s*=/;

/**
 * What a key is: the name that says a secret, whether a number after it is a count or a PIN, whether it is compared
 * through a property or is a ternary's quoted branch ("token.value === …", '? "password" : …'), so a literal after it is
 * code unless shaped like a password, whether typeof reads it ("typeof token === …"), whether it is a shell's
 * variable, whose unquoted value is a literal ("export DB_PASSWORD=changeme"), never a name (memory-v5-2), and whether
 * it stands inside a bracket a line of code opened above it or that the next line closes, so its line is code however
 * it ends ("auth = {\n  password: urlPassword\n};"): memory-w5-2. `codeId`: a member's assignment in code (a line
 * that ends with ";", an indented one or one inside a bracket), whose bare name after it is a variable ("token.line =
 * line;"), never a config file's line ("passwords.home = hunter"): safety-privacy-r5-1.
 */
interface CodeKey { name: string; count: boolean; pin: boolean; compared: boolean; typeOf: boolean; shell: boolean; inside: boolean; codeId?: boolean; about?: boolean; nameOf?: boolean }

/** The last word of a key that names where a secret is or what it is called, never the secret ("FIELD", "HEADER", "Name"). */
const NAME_OF = /^(?:field|fields|header|headers|name|names|param|params|label|labels|id|ids|attr|attribute|env|var|variable|prop|property|column|cookie|slot|input|selector|path|url|uri|endpoint|file|type|kind|ref|prefix|placeholder|message|msg|error|hint)$/i;
/** The end of a value in code: the line's end, a comma, a semicolon, a closing bracket or a comment. */
const CODE_AFTER_END = /^\s*(?:$|[,;)\]}]|\/\/|#)/;
/**
 * A label's words, a colon at their end ("Password:", "PIN :"), letters only, among them a secret's name or a field's
 * ("Username:", "E-mail:"), never another word ("hunter:", "Summer:"): memory-x6-3.
 */
const label = (s: string) => /^[\p{L}_][\p{L}_ '’-]{0,40}:\s*$/u.test(s)
  && s.split(/[\s_:'’-]+/).some(w => SENTENCE_WORD.test(w) || /^(?:user(?:name)?|name|mail|account|id|code|phrase|answer|otp)$/i.test(w));
/**
 * An address with no credentials in it, and none of its parts shaped like a token ("https://oauth2.googleapis.com/token",
 * never "https://user:pass@host" or a webhook's "https://hooks.slack.com/services/T0/B0/x8Kq…"): memory-r4-2.
 */
function plainUrl(s: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(s) || /:\/\/[^/\s]*@/.test(s)) return false;
  return s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?&=#;:.]/).every(p => !(p.length >= 16 && /\d/.test(p) && /[A-Za-z]/.test(p)) && !/[!@$%^*]/.test(p));
}
/**
 * Words after a type or an environment read in a request, that say what is done with it, and no value in the rest of
 * the sentence (no digit or symbol): "field to the Session interface", "fail validation?", "optional".
 */
const PROSE_WORD = String.raw`field|fields|option|options|prop|props|property|properties|param|params|parameter|parameters|arg|args|argument|arguments|attribute|attributes|member|members|column|columns|type|types|value|values|key|entry|setting|variable|to|in|into|as|from|for|on|optional|required|instead|with|and|or|but|is|are|was|were|be|fails?|failed|failing|breaks?|broke|gets?|got|causes?|throws?|works?|isn['’]t|doesn['’]t|does|do|should|would|could|can|will|must|may|might|here|there|now|correctly|properly|a|an|the|everywhere|anywhere|appears?|shows?|prints?|logs?|logged|leaks?|comes?|returns?|returned|becomes?|stays?|set|used|stored|defined|declared|read|written|passed|sent|kept|saved|with`;
function proseAfter(rest: string): boolean {
  return new RegExp(String.raw`^\s+(?:${PROSE_WORD})\b`, "i").test(rest) && !/[0-9!@#$%^&*]/.test(rest.split(/[.?!\n]/)[0]!.slice(0, 160));
}

/** Whether `v`, what follows a secret-named key's ":" or "=" on `line`, reads as code rather than a value. */
function readsAsCode(key: CodeKey, v: string, line: string, op = "="): boolean {
  // A type, unless a literal in it is shaped like a password ("type Password = 'Summer2024!'"): safety-privacy-r5-1.
  if (TYPE_ALIAS.test(line)) return !literalsIn(v).some(l => secretShaped(l.s));
  if (holdsLiteral(v)) return false;
  const inCode = key.inside || codeish(line);
  // A format string's placeholder for a name or a number, inside the string ('f"Failed to refresh token: {e}"', "'No
  // aud field in token: {0}'"), never a password in braces ("{hunter2}"): memory-w5-2. What follows the string is
  // read too, so a password it is formatted with or a comment after it stays a value ('"password: {0}".format(
  // "Summer2024!")', "f'password: {pw}'  # Summer2024!"): safety-privacy-r5-1.
  const holder = /^\{([A-Za-z_][\w.]*|\d*)(?:![rsa])?(?::[^{}"'`\n]*)?\}/.exec(v);
  if (holder && holder[1]!.split(".").every(w => /^\d*$/.test(w) || codeLineName(w)) && line.endsWith(v)) {
    const before = line.slice(0, line.length - v.length);
    const after = v.slice(holder[0].length);
    const q = ['"', "'", "`"].find(c => (before.split(c).length - 1) % 2 === 1 && after.includes(c));
    if (q !== undefined) {
      const tail = after.slice(after.indexOf(q) + 1);
      const comment = /(?:#|\/\/)([^\n]*)/.exec(tail)?.[1] ?? "";
      return !holdsLiteral(tail) && !comment.split(/\s+/).some(w => secretShaped(w.replace(/[,.;:]+$/, "")));
    }
  }
  // A word with a digit or a symbol in brackets or after a comment's mark is a value written that way ("(hunter2)",
  // "<P@ss>", "[Summer2024, Winter2025]", "# hunter2"), unless a line of code names a variable so ("[node1]").
  const bracket = /^(?:[([{<]|\/\/|\/\*|#)([^()[\]{}<>\n]{0,80})/.exec(v)?.[1];
  const valueWord = (w: string) => !/^["'`]/.test(w) && !/[_.(]/.test(w) && (/[!@#$%^&*]/.test(w) || (/[A-Za-z]/.test(w) && /\d/.test(w)));
  if (bracket !== undefined && bracket.split(/[\s,;|:=]+/).some(w => valueWord(w) && !(CODE_LINE.test(line) && /^[([]/.test(v) && codeLineName(w)))) return false;
  // A comment, a bracket with code in it, a regular expression, a reference, a YAML tag or a borrow ("&str", "&[u8]")
  // where the value would be; never YAML's block markers ("|", ">"), whose value is on the lines after.
  if (/^(?:\/\/|\/\*|#\s|\/[\^([\\]|&(?:str\b|mut\b|self\b|\[|'|[A-Z][A-Za-z]*\b(?!\d))|![A-Za-z]+\s+\S)/.test(v) || REFERENCE.test(v)) return true;
  if (/^[([{<]/.test(v)) return codeInBracket(v, op !== ":" || inCode);
  const quoted = /^(["'`])(.*?)\1/.exec(v);
  if (quoted) {
    const s = quoted[2]!;
    // A type's string values ('"password" | "text"'), what typeof gives in a comparison, and one or two characters.
    // A label, a sentence about the secret, an address with no credentials in it, or what a key that names where the
    // secret is holds ('"passwordLabel": "Password:"', '"forgotPassword": "Forgot your password?"', 'TOKEN_URL =
    // "https://oauth2.googleapis.com/token"', 'PASSWORD_FIELD = "password"'): memory-r4-2, integrations-r4-1.
    if (label(s) || sentence(s) || plainUrl(s) || (key.nameOf === true && !/:\/\//.test(s) && !secretShaped(s) && !tokenShaped(s))) return true;
    return s === "" || PLACEHOLDER.test(s) || REFERENCE.test(s) || VERSION.test(s) || /^(?:\.{1,2}|~)\//.test(s)
      || (!key.pin && (/^[^\w\s]{1,3}$/.test(s) || s.length <= 2)) || (quoted[1] === "`" && s.includes("${"))
      || (key.compared && !secretShaped(s)) || /^\s*\|\s*["'`]/.test(v.slice(quoted[0].length))
      || (key.typeOf && /^(?:string|number|boolean|object|undefined|function|symbol|bigint)$/.test(s));
  }
  if (/^["'`]/.test(v)) return false;
  const word = /^[^\s,;)\]}"'`]+/.exec(v)?.[0] ?? "";
  // A bare name under a key that names where the secret is ("secretName: db-credentials"): integrations-r4-1.
  if (key.nameOf === true && /^[A-Za-z][\w.-]*$/.test(word) && !secretShaped(word) && CODE_AFTER_END.test(v.slice(word.length))) return true;
  // A type, an empty value or an environment read named in a request, with words after it and no value among them
  // ("Add a token: string field", "Why does token: null break the header?", "Make apiKey: process.env.KEY optional"):
  // integrations-r4-1. Never "PIN: number 4821" or "Password: string cheese".
  const typed = /^(?:string|str|number|int|integer|float|boolean|bool|bigint|null|undefined|None|any|unknown|(?:process\.env|import\.meta\.env|os\.environ)\.[A-Z_][A-Z0-9_]*)(?=\s)/.exec(v)?.[0];
  if (typed !== undefined && proseAfter(v.slice(typed.length))) return true;
  // A setting's own name and a value that isn't shaped like a password ("AWS_PROFILE=dev2").
  const setting = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*=([^\s,;]*)/.exec(v);
  if (PLACEHOLDER.test(word) || (key.shell ? SHELL_CODE.test(v) : CODE_TYPE.test(v) || CODE_WORD.test(v)) || (setting && !secretShaped(setting[1]!))) return true;
  // A negated member ("!!n.secret", "!opts.token").
  if (!key.shell && /^!!?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+/.test(v)) return true;
  const num = /^-?(?:0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?)(?![\w$@.!#%&*:/-])/i.exec(v)?.[0];
  // After a prose label's ":", only a one- or two-digit number, never "Password: 0xCAFE" (memory-v5-3).
  const short = op === ":" && !inCode ? /^\d{1,2}$/ : /^-?(?:\d{1,2}|0x[0-9a-f]{1,4}|\d*\.\d+(?:e[-+]?\d+)?)$/i;
  if (num) return key.count || (!key.pin && short.test(num));
  // A shell's unquoted word is its value, whatever it looks like (memory-v5-2).
  if (key.shell) return false;
  // A call, an index or a generic, written as code does with nothing between ("loadCreds(argv[2])", "tokens[0]",
  // "Optional[str]", "Record<string, …>"), never "hunter (the usual)".
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*!?[([]|^[A-Za-z_$][\w$.]*<[A-Za-z_$]/.test(v)) return true;
  // A member or a name, with code after it ("node.callee;", "creds_v2,", "pw || …"), never more words.
  const ends = new RegExp(String.raw`^${CODE_AFTER}`);
  const operator = /^\s*(?:\|\||&&|\?\?|\?\s|[+*%]\s|[=!]==?|[<>]=?\s)/;
  const member = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+(?![\w$@.!#%&*-])/.exec(v)?.[0];
  if (member) {
    const rest = v.slice(member.length);
    // A member read in code, named in a request with words after it ("Replace apiKey: config.key with …"):
    // integrations-r4-1.
    if (!ends.test(rest) && CODE_OBJECTS.has(member.split(".")[0]!.toLowerCase()) && !/\d/.test(member) && proseAfter(rest)) return true;
    // "self.made99" outside code is a password written so (memory-v5-3).
    if (!ends.test(rest) || (/^(?:this|self|super|cls)\./.test(member) && /\d/.test(member) && !inCode)) return false;
    return codeMember(member) || CODE_LINE.test(line) || (/;\s*(?:\/\/.*)?$/.test(line) && /^[a-z.]+$/.test(member)) || op.startsWith("==") || operator.test(rest);
  }
  const id = /^[A-Za-z_$][\w$]*(?![\w$@.!#%&*^~+=:/-])/.exec(v)?.[0];
  if (!id) return false;
  const after = v.slice(id.length);
  if (!ends.test(after)) return false;
  // The same name, a variable named for a secret, a name of three letters and an operator are code only in code, never
  // after a prose label's ":" ("The router's password: password", "My Wi-Fi password: abc", "Password: rex + 1985"),
  // but for an indented field's type ("  token: Token"): memory-v5-3.
  const named = id.toLowerCase() === key.name.toLowerCase() || namesSecret(id);
  if (op === ":" && !inCode) return named && /^[A-Z][A-Za-z]*$/.test(id) && /^[a-z]/.test(key.name) && /^[ \t]+[a-z]/.test(line);
  return named || (!key.pin && id.length <= 3)
    || operator.test(after) || (op.startsWith("==") && !/\d/.test(id)) || ((CODE_LINE.test(line) || key.codeId === true) && codeLineName(id));
}

/**
 * Whether `line` reads as code, not a label and its value: a line of code, one that ends as code does (",", ";", "{"…),
 * a quoted key's, or a key inside an object or a call ("foo({ token: token })").
 */
function codeish(line: string): boolean {
  return CODE_LINE.test(line) || /[,;{([]\s*(?:(?:\/\/|#).*)?$/.test(line) || /^\s*["'][^"'\n]*["']\s*:/.test(line)
    || /[{(][^)}]*[A-Za-z_$][\w$]*["']?\s*:/.test(line);
}

/**
 * The bracket ("(", "[" or "{") opened on an earlier line that the line at `lineStart` stands inside, at most 2 KiB
 * before it, or undefined: only a line of code opens one (one that starts or ends as code does, never "(My notes:" or
 * words before a spaced bracket, "Router ("), so prose in brackets never does. A call's, a signature's or an object's
 * own lines read as code by it ("connect(\n    password=password\n)", "auth = {\n  password: urlPassword\n}"):
 * memory-w5-1, memory-w5-2. The text is read once, forwards, so the lines must be asked for in order.
 */
function openedAbove(text: string): (lineStart: number) => string | undefined {
  const open: number[] = [];
  let at = 0;
  let asked = -1;
  let answer: string | undefined;
  return lineStart => {
    if (lineStart === asked) return answer;
    for (; at < lineStart; at++) {
      const c = text[at];
      if (c === "(" || c === "[" || c === "{") open.push(at);
      else if (c === ")" || c === "]" || c === "}") open.pop();
    }
    const i = open.at(-1);
    asked = lineStart;
    answer = undefined;
    if (i === undefined || i < lineStart - 2048) return answer;
    // Its line, at most 200 characters either side of it, so a long line stays linear.
    const head = text.slice(Math.max(0, i - 200), i);
    const line = head.slice(head.lastIndexOf("\n") + 1) + text.slice(i, Math.min(lineStart - 1, i + 200));
    if ((CODE_LINE.test(line) || /[,;{([]\s*(?:(?:\/\/|#).*)?$/.test(line)) && !/^\s*[A-Z][A-Za-z0-9'’ -]*\s[({[]\s*$/.test(line)) answer = text[i];
    return answer;
  };
}

/**
 * Whether a value that opens with a bracket is code ("[]", "{", "(await getToken())", "{ type: String }", "[token]",
 * "[str]", "<your-key>", an arrow's parameters, names or numbers in code: "[bos]", "(where, at) =>"), never a word
 * written in one after a label ("Netflix password: (fluffy)", "Wi-Fi password: [BlueSky]"): memory-v5-3.
 */
function codeInBracket(v: string, inCode: boolean): boolean {
  const first = /^\S+/.exec(v)![0].replace(/[,;]$/, "");
  if (BRACKET_HOLDER.test(first) || BRACKET_CAPS.test(first) || /^\([^()]*\)\s*(?::\s*[^=]{1,80})?=>/.test(v)) return true;
  const inner = /^[([{<]([^)\]}>\n]*)/.exec(v)![1]!.trim();
  if (!inner || /[.(){}[\]<>:=;"'`$*&|+]|\bfor\b.*\bin\b/.test(inner)) return true;
  return inner.split(/[\s,]+/).every(w => namesSecret(w) || CODE_TYPE.test(w) || /^(?:\.{3}|…)$/.test(w)
    || (inCode && (codeLineName(w) || /^-?\d+$/.test(w))));
}

/**
 * Whether `id`, a bare name in a line of code, is a variable's: one without digits, or with "_" or a lowercase start
 * and a hump ("node", "creds_v2", "mapToken2"), never capitalised words with digits or a long run of letters and digits,
 * which are how passwords and tokens are written ("Summer2024", "abc123def456ghi789").
 */
function codeLineName(id: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(id) && (!/\d/.test(id) || id.includes("_") || /^[a-z][a-z0-9]*[A-Z]/.test(id))
    && !/^[A-Z][a-z]+_?\d/.test(id) && !(/^[A-Za-z0-9]{12,}$/.test(id) && /\d/.test(id));
}

/**
 * A child's name that says a setting, whose value is never a secret ("username: admin", "file: ./db.txt", "type:
 * String", "ssid: HomeNet", "min_length: 12"), by any of its words.
 */
const SETTING_WORDS = /^(?:types?|kinds?|names?|labels?|ids?|uid|user|users|username|usernames|email|emails|mail|file|files|path|paths|dir|folder|url|urls|uri|uris|endpoint|host|hosts|hostname|port|ports|region|zone|provider|source|format|encoding|algorithm|alg|scheme|scopes?|audience|issuer|enabled|disabled|enable|disable|required|optional|mode|ssid|network|country|band|channel|interface|description|desc|title|help|environment|role|roles|account|project|tenant|group|groups|policy|rotation|backend|engine|driver|store|mount|version|location|method|methods|header|prefix|suffix|pattern|regex|field|fields|placeholder|class|style|icon|model|lang|language|locale|unique|index|select|lowercase|uppercase|trim|validate|validator|validators|nullable|primary|secure|encrypted|ciphertext|sealed|enum|choices|options|allowed|state|status|action|repeated)$/i;
/** The words of a strong secret's name, under which a literal is the secret itself whatever the child it is under says. */
const STRONG_SECRET = new Set(["password", "passwords", "passwd", "pwd", "pw", "pass", "passphrase", "passcode", "secret", "secrets", "token", "tokens",
  "credential", "credentials", "creds", "apikey", "psk", "wifi"]);
/**
 * Whether `s`, a literal, is a sentence about a secret, not one: three or more words, one of them naming a secret
 * ("Forgot your password?", "Passwords don't match", "Mot de passe oublié"), never a passphrase of words alone. An
 * English word for one is a noun as a UI's text uses it, after a word like "your", "the", "enter" or "of", or before
 * one like "is", "don't" or "required" ("Sign in", "logged out"), and no word is shaped like a password or is a run of
 * four digits, so "sign of four 1887", "Key Lime Pie 2024!", "login now 4821" and "pass the salt please" are values
 * (memory-x6-3).
 */
const SENTENCE_WORD = /^(?:pass(?:word|words|phrase|code)?|passe|passwort|kennwort|contrase[ñn]a|senha|wachtwoord|parola|hasło|pins?|tokens?|secrets?|keys?|credentials?|login|sign|logged|api)$/i;
const SENTENCE_BEFORE = /^(?:your|the|a|an|my|our|their|his|her|its|this|that|no|new|current|old|temporary|confirm|enter|re-?enter|retype|repeat|type|forgot|forgotten|reset|change|choose|create|set|update|show|hide|invalid|incorrect|wrong|of|for|with|by|to|without)$/i;
const SENTENCE_AFTER = /^(?:is|are|was|were|be|been|has|have|had|must|should|will|can|cannot|can['’]t|could|do|does|did|don['’]t|doesn['’]t|didn['’]t|isn['’]t|aren['’]t|wasn['’]t|not|required|needed|incorrect|invalid|expired|expires|mismatch|match|matches|too|field|reset|changed|updated|saved|sent|strength|hint|failed|succeeded|successful)$/i;
function sentence(s: string): boolean {
  const ws = s.trim().split(/\s+/);
  if (ws.length < 3 || ws.some(w => secretShaped(w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")) || /\d{4}/.test(w))) return false;
  const bare = ws.map(w => w.replace(/^[^\p{L}'’]+|[^\p{L}'’]+$/gu, ""));
  return bare.some((w, i) => {
    const n = w.replace(/[^\p{L}]+/gu, "");
    if (!SENTENCE_WORD.test(n)) return false;
    // The other languages' words name only a password ("Mot de passe oublié", "Passwort vergessen?").
    if (!/^(?:pass(?:word|words|phrase|code)?|pins?|tokens?|secrets?|keys?|credentials?|login|sign|logged|api)$/i.test(n)) return true;
    const next = bare[i + 1] ?? "";
    return SENTENCE_BEFORE.test(bare[i - 1] ?? "") || SENTENCE_AFTER.test(next) || (/^(?:sign|login|logged)$/i.test(n) && /^(?:in|up|out|on|off)$/i.test(next));
  });
}
/** Whether `s`, a literal under a name for tokens, could be one: shaped like a secret, or a run of 12 or more letters and digits. */
const tokenShaped = (s: string) => secretShaped(s) || (!/[\s\\/]|:\/\//.test(s) && s.length >= 12 && /\d/.test(s) && /[A-Za-z]/.test(s));

/**
 * Whether the lines under a secret-named key that ends its line hold a literal for it (safety-privacy-r5-1,
 * safety-privacy-c5-1): a YAML mapping or list indented under it ("passwords:\n  db: Summer2024!", "password:\n
 * production: …"), or the members of a bracket that ends its line, up to the bracket that closes it ('"secrets": {\n
 * "db": "…"\n}', "PASSWORDS = [\n  \"…\",\n]", an HCL block). A child whose own name is a setting ("username", "type",
 * "min_length") or a reference to a key by its name ("key: password") holds none, and code where a value would be
 * (a call, a reference, a variable in code, a count) holds none; a literal or a bare word in YAML does. Under a name
 * for tokens (a lexer's, a design system's), only a literal shaped like a token counts, and under a PIN's a short
 * number is a pin's (a board's "led: 13"). Under a key that doesn't start its line (a block's "if …:", "class
 * Password:"), only a literal shaped like a password counts. At most 40 lines and 2 KiB are read.
 */
function holdsUnder(text: string, from: number, keyIndent: number, key: CodeKey, bracket: boolean, opener: string, block: boolean): boolean {
  const ws = words(key.name).map(w => w.toLowerCase());
  const tokens = ws.some(w => /^tokens?$/.test(w)) && !ws.some(w => !/^tokens?$/.test(w) && (STRONG_SECRET.has(w) || /^(?:keys?|pins?)$/.test(w)));
  const stop = Math.min(text.length, from + 2048);
  let depth = 1;
  let at = from;
  // A setting's own nested lines or bracket, passed over whole: the indent its lines stand under, or its depth.
  let skipIndent = -1;
  let skipDepth = 0;
  for (let n = 0; n < 40 && at < stop; n++) {
    const nl = text.indexOf("\n", at);
    let raw = text.slice(at, nl < 0 ? stop : Math.min(nl, stop));
    at = nl < 0 ? stop : nl + 1;
    const indent = /^[ \t]*/.exec(raw)![0].length;
    const lineDepth = depth;
    let closed = false;
    if (bracket) {
      // Only the bracket's own members, never what follows once it closes.
      let quote = "";
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i]!;
        if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "{" || c === "[" || c === "(") depth++;
        else if ((c === "}" || c === "]" || c === ")") && --depth === 0) { raw = raw.slice(0, i); closed = true; break; }
      }
    }
    const t = raw.trim();
    if (closed && !t) return false;
    if (!t || /^(?:#|\/\/|\/\*|\*|<!--)/.test(t)) continue;
    if (bracket) {
      if (skipDepth) { if (lineDepth >= skipDepth) { if (closed) return false; continue; } skipDepth = 0; }
      if (/^[)\]}]/.test(t)) { if (closed) return false; continue; }
    } else {
      if (indent <= keyIndent) return false;
      if (skipIndent >= 0) { if (indent > skipIndent) continue; skipIndent = -1; }
    }
    const item = t.replace(/^-\s+/, "").replace(/[,;]\s*$/, "");
    const member = /^(?:["']([^"'\n]{1,128})["']|:?([A-Za-z_$][\w$.-]{0,127}))\s*(=>|:(?!:)|=(?!=))\s*(.*)$/.exec(item);
    const name = member ? member[1] ?? member[2]! : "";
    const value = (member ? member[4]! : item).replace(/\s+(?:#|\/\/)\s.*$/, "").trim();
    const own = words(name);
    // A setting's value, and all that is nested under it ("description: |", "validators: [").
    if (member && !own.some(w => STRONG_SECRET.has(w.toLowerCase())) && own.some(w => SETTING_WORDS.test(w) || COUNT_PARTS.test(w))) {
      if (bracket) { if (depth > lineDepth) skipDepth = depth; } else skipIndent = indent + (/^-\s/.test(t) ? 2 : 0);
      if (closed) return false;
      continue;
    }
    // A block's body under a line of code ("if node.type == token.INDENT:\n    start = 2", "class Password:"): only a
    // literal shaped like a password is one.
    if (block ? literalsIn(item).some(l => secretShaped(l.s)) : holdsValue(value, name, member?.[3], own, key, tokens, bracket, opener, raw)) return true;
    if (closed) return false;
  }
  return false;
}

/** Whether `value`, a child's under a secret-named key (holdsUnder), is a literal for that secret. */
function holdsValue(value: string, name: string, op: string | undefined, own: string[], key: CodeKey, tokens: boolean, bracket: boolean, opener: string, raw: string): boolean {
  // A nested mapping or bracket, or a block's marker: its own lines are read next.
  if (!value || /^[{[(]$/.test(value) || /^[|>][+-]?\d?$/.test(value)) return false;
  // A reference to a secret by its name ("key: password", "secretName: db-credentials" under "secretKeyRef:").
  if (op && /^(?:key|keys|ref|secretname|secret_name|keyname|key_name)$/i.test(name) && /^["']?[a-z][\w.-]*["']?$/.test(value)
    && namesSecret(value.replace(/["']/g, "").replace(/[.-]/g, "_"))) return false;
  if (key.pin && /^\d{1,3}$/.test(value)) return false;
  // A YAML alias or anchor ("*project", "&defaults").
  if (/^-?[*&][A-Za-z_][\w.-]*$/.test(value)) return false;
  const literal = /^(["'`])(.*)\1$/.exec(value)?.[2];
  // A literal that names a secret ("'projects.secrets'", "\"api_key\"") or says something about one in a sentence
  // ("base64 encoded json representation of credentials."): its words are read by the other rules all the same. A
  // name has no spaces, so "pass the salt please" is a passphrase (memory-x6-3).
  if (literal !== undefined && ((!/\s/.test(literal.trim()) && namesSecret(literal.replace(/[.\s/:-]+/g, "_"))) || sentence(literal))) return false;
  // A bare name that names a secret, as a list of them does ("secrets:\n  - db_password").
  if (literal === undefined && /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/.test(value) && !/\d/.test(value) && namesSecret(value.replace(/[.-]/g, "_"))) return false;
  // Under a name for tokens, only one token, alone: never an expression or a lexer's rule ("(r'\\d+', Number)").
  if (tokens) return /^[\w+/=.~-]+$/.test(literal ?? value) && tokenShaped(literal ?? value);
  // In code, a bare name is a variable ("db: dbPassword", "prod = var.prod_password", "...defaults").
  if (bracket && CODE_LINE.test(opener) && /^(?:\.{3})?[A-Za-z_$][\w$.]*$/.test(value) && !/^(?:true|false|null|none|nil)$/i.test(value)
    && !secretShaped(value) && (codeLineName(value.replace(/^\.{3}/, "")) || /\./.test(value))) return false;
  const child: CodeKey = { ...key, count: key.count || own.some(w => COUNT_PARTS.test(w)), compared: false, typeOf: false, shell: false, inside: bracket, codeId: false };
  return !readsAsCode(child, value, raw, op && op !== ":" ? "=" : ":");
}

/** A quoted literal alone, then the end, a comma, a closing bracket or a comment ("'Summer2024!',", '"hunter2" }'). */
const LONE_LITERAL = /^(["'`])(?:(?!\1)[^\\\n]|\\.)*\1\s*(?:[,;)\]}]|#|\/\/|$)/;

/**
 * `text` with the name of each secret-named key whose ":" or "=" is followed by code written out as "_" (memory-r4-1,
 * memory-r4-2), so neither the redactor nor this guard reads that code as the secret's value. Its value is kept.
 * `held` is set when a strong secret's name (a password's, a token's, credentials') has a literal under it on the
 * lines after, which the redactor wouldn't see as its value (safety-privacy-r5-1, safety-privacy-c5-1).
 */
function withoutCodeKeys(text: string, found?: { held: boolean }): string {
  let out = "";
  let at = 0;
  const above = openedAbove(text);
  for (const m of text.matchAll(KEY_BEFORE_SEP)) {
    const name = m[0];
    if (!SECRET_IN_NAME.test(name) || redactSecrets(name) !== name) continue;
    const start = m.index;
    let i = start + name.length;
    if (text[i] === '"' || text[i] === "'") i++;
    while (/\s/.test(text[i] ?? "")) i++;
    const op = /^(?:===?|=>|:=|::|[:=])/.exec(text.slice(i, i + 3))![0];
    i += op.length;
    // The member that says the secret ("self.password", "creds.refresh_token"), and any after it ("token.type").
    const segs = name.split(".");
    let s = segs.length - 1;
    while (s > 0 && !SECRET_IN_NAME.test(segs[s]!)) s--;
    const own = words(segs[s]!);
    const property = s < segs.length - 1;
    const count = own.some(w => COUNT_PARTS.test(w)) || (own.length > 1 && own.some(w => /^tokens$/i.test(w)));
    const before = text.slice(Math.max(0, start - 8), start);
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const key: CodeKey = {
      name: segs[s]!, count, pin: !count && own.some(w => PIN_PARTS.test(w)),
      compared: (property && op.startsWith("==")) || /\?\s*["'`]$/.test(before), typeOf: op.startsWith("==") && /\btypeof\s+$/.test(before),
      shell: op === "=" && text[start + name.length] === "=" && /^[A-Za-z_]\w*$/.test(name) && /^[^\s,)]\S*(?<![,):])(?!\S)/.test(text.slice(i, i + 400))
        && (SHELL_BEFORE.test(text.slice(lineStart, start))
          || (/^[A-Z_][A-Z0-9_]*$/.test(name) && SHELL_CAPS_BEFORE.test(text.slice(lineStart, start)) && !/[([]/.test(above(lineStart) ?? ""))),
      inside: false,
      // A key that names where the secret is or what it is called ("PASSWORD_FIELD", "API_KEY_HEADER", "secretName",
      // "TOKEN_URL"), whose value is never the secret (memory-r4-2, integrations-r4-1).
      nameOf: words(name.split(".").at(-1)!).length > 1 && NAME_OF.test(words(name.split(".").at(-1)!).at(-1)!),
    };
    let code: boolean;
    // A name whose only secret-looking words never name one ("tokenizer", "keyboardLayout").
    const looks = words(segs[s]!).filter(w => SECRET_IN_NAME.test(w));
    const notSecret = looks.length > 0 && looks.every(w => NOT_SECRET_WORD.test(w));
    // Each look is bounded (a value's first 400 characters, its line's first and last 200), so a long line of keys
    // stays linear.
    const lineEnd = text.indexOf("\n", i);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const rest = text.slice(i, Math.min(end, i + 400)).replace(/^[ \t]+/, "");
    const line = end - lineStart <= 400 ? text.slice(lineStart, end) : `${text.slice(lineStart, lineStart + 200)}\n${text.slice(end - 200, end)}`;
    // A hash's entry ("'password' => …", ":password => …"), whose quoted key or symbol an arrow's parameter never has.
    const entry = op === "=>" && (/["']/.test(text[start - 1] ?? "") || (text[start - 1] === ":" && text[start - 2] !== ":"));
    const ownStrong = words(name).some(w => STRONG_SECRET.has(w.toLowerCase()));
    // A name whose last word says the secret holds it under it ("passwords:", "SECRETS = {", "api_keys:"), never one
    // about it ("PASSWORD_RULES = {", "tokenProperties = [", "secretKeyRef:").
    const holder = /^(?:keys?|pins?|otp|cvv)$/i.test(own.at(-1) ?? "") || STRONG_SECRET.has((own.at(-1) ?? "").toLowerCase());
    // Whether the key starts its line, as a mapping's or a setting's does ("passwords:", "secrets.db: …").
    const first = /^[ \t]*(?:-[ \t]+)?["']?$/.test(text.slice(lineStart, start));
    // A lone literal after an arrow, or a lone word shaped like a password or a PIN's number ("password =>
    // Summer2024!", "pin => 4821").
    const loneWord = /^[A-Za-z0-9][^\s"'`(){}[\],;]*(?=\s*(?:$|[,;)\]}]))/.exec(rest)?.[0];
    const lone = LONE_LITERAL.test(rest) || (loneWord !== undefined && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(loneWord)
      && (secretShaped(loneWord) || (key.pin && /^\d{4,12}$/.test(loneWord))));
    // A path ("Token::Kind"), an arrow's parameter with code after it ("token => token.trim()"), never a hash's entry
    // or a lone value after it: safety-privacy-r5-1. A name that ends a sentence ("…from a refresh_token.\n\n:param …")
    // and a property before a block's ":" ("if node.type == token.SEMI:").
    if (notSecret || op === "::" || (op === "=>" && !entry && !lone) || segs.at(-1) === "" || (property && op === ":" && !first)) code = true;
    // A property compared ("token.type === …", "tokenBefore.loc.end.line ===\n  …"), unless with a password.
    else if (property && op.startsWith("==") && !VALUE_PROPERTY.test(segs.at(-1)!)) code = !literalsIn(rest).some(l => secretShaped(l.s));
    else {
      if (property) {
        // A property about the secret is compared like one ("token.type = 'bearer'"), and a number after it is never
        // the secret; another names one of several ("secrets.db = …"), whose value is that secret: safety-privacy-r5-1.
        const last = segs.at(-1)!;
        if (ABOUT_PROPERTY.test(last.replace(/[_-]/g, ""))) { key.compared = true; key.count = true; key.about = true; }
        // A PIN's member is one of several ("pins.led = 13"), whose short number is a pin's, never a PIN.
        else if (!VALUE_PROPERTY.test(last)) key.pin = false;
        // In code, a bare name after it is a variable ("token.line = line;"): a line that ends with ";", is indented
        // or stands inside a bracket, or a member of self or this.
        key.codeId = /;\s*(?:\/\/.*)?$/.test(line) || /^[ \t]/.test(line) || /^(?:this|self)\./.test(name);
      }
      // Inside a bracket a line of code opened above it, or a list's last item, after one that ends with ",", before the
      // line that closes it (memory-w5-2).
      key.inside = above(lineStart) !== undefined || (lineEnd >= 0 && /^\s*[)\]}]/.test(text.slice(lineEnd + 1, lineEnd + 401))
        && /,[ \t]*(?:\n[ \t]*)*$/.test(text.slice(Math.max(0, lineStart - 400), lineStart)));
      if (property && key.inside) key.codeId = true;
      // A bracket that ends its line opens the secret's values, its members read up to the bracket that closes it
      // ('"secrets": {\n  "db": "…"\n}', "PASSWORDS = [\n  \"…\",\n]"): safety-privacy-c5-1.
      if (holder && /^[{[]\s*(?:(?:\/\/|#)[^\n]*)?$/.test(rest) && lineEnd >= 0) {
        const holds = holdsUnder(text, lineEnd + 1, 0, key, true, line, false);
        if (holds && ownStrong && found) found.held = true;
        code = !holds;
      } else if (rest && key.about) {
        // What a property about the secret holds is never the secret, unless it is shaped like one ("password.type:
        // hunter2"): "password.file=filepath", "token.start = pos + 1".
        const bare = /^[^\s"'`(){}[\],;]+(?=\s*(?:$|[,;)\]}]|#|\/\/))/.exec(rest)?.[0];
        code = !holdsLiteral(rest) && !(bare !== undefined && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(bare) && secretShaped(bare));
      } else if (rest) code = readsAsCode(key, rest, line, op);
      else {
        // Nothing after it on its line: a block, a mapping, a comment or a statement follows, unless the next line is
        // its value ("Wi-Fi password:\nBlueSky99").
        const next = lineEnd < 0 ? undefined : /^[ \t]*\S[^\n]*/m.exec(text.slice(lineEnd + 1, lineEnd + 1 + 400))?.[0];
        // A mapping or a statement only indented under it, a comment's next line only in a comment, never prose on
        // the next line ("Admin password:\ndefault is admin123", "Wi-Fi password:\n* BlueSky99"): memory-v5-3.
        // A statement may follow at the same depth after a block's own line or a comment ("case X:\ncase Y:").
        const indent = /^[ \t]*/.exec(line)![0].length;
        const under = next !== undefined && /^[ \t]*/.exec(next)![0].length > indent;
        const block = CODE_STATEMENT.test(line.trim()) || /^\s*(?:\/\/|\/\*|\*|#)/.test(line);
        // A Python block's body under its own line ("if not tokens:\n    return \"\"", "for token in tokens:\n
        // yield token.kind, token.value"): memory-w5-2. Never one that returns a password ("if password:\n    return
        // 'Summer2024!'"): safety-privacy-r5-1.
        const body = under && PY_BLOCK.test(line) && PY_STATEMENT.test(next.trim()) && !literalsIn(next.trim()).some(l => secretShaped(l.s));
        // A mapping or a list under it holds the secret's values unless each is a setting or code ("passwords:\n
        // db: Summer2024!" holds one, "credentials:\n  username: admin" none): safety-privacy-r5-1.
        const mapping = under && /^\s*(?:-\s+\S|(?:-\s+)?["']?[A-Za-z_$][\w$.-]*["']?\s*[:=])/.test(next);
        const holds = mapping && holder && holdsUnder(text, lineEnd + 1, indent, key, false, line, !first);
        if (holds && ownStrong && found) found.held = true;
        code = !holds && (next === undefined || body || mapping || ((under || block) && codeStatement(next.trim()))
          || (/^\s*(?:\/\*|\*)/.test(line) && /^\s*\*(?:\s|$)/.test(next)) || readsAsCode(key, next.trim(), next, op));
      }
    }
    if (!code) continue;
    out += text.slice(at, start) + "_".repeat(name.length);
    at = start + name.length;
  }
  return at === 0 ? text : out + text.slice(at);
}

/**
 * A secret's name as a prompt's or a label's words, with nothing where its value would be (memory-r4-2): a string that
 * ends after its ":" and code after the string (`input("Password: ")`, `getpass.getpass("Password: ")`,
 * `Console.Write("Password: ");`, `read -s -p "Password: " PASS`), with no word shaped like a password in that code
 * or a comment after it, or an element's text that ends there with no text after it up to the field it labels
 * (`<label for="password">Password:</label>`, `Password: <input type="password">`): valueAfterLabel. Only the name is
 * written out. `<td>Password:</td><td>hunter2</td>`, `<p>Your PIN:</p>\n\n<p>4821</p>`, `echo "Password:" hunter2`,
 * `print("Password:", "hunter2")` and `input("Password: ")  # Summer2024!` stay values (memory-x6-1).
 */
const LABEL = /\b(?:pass(?:word|phrase|code)?|passwd|pwd|pin|passcode|token|secret|api[ _-]?key)s?[ \t]*:[ \t]*(?=["'`<])/gi;
/** An HTML element's tag where a label's text ends, never a word in angle brackets ("<hunter>", "<your password>"). */
const HTML_TAG = /^<\/?(?:label|input|td|th|tr|span|div|p|b|strong|i|em|u|small|dt|dd|li|a|button|select|option|br|code|font|legend|fieldset|form|h[1-6])(?:\s[^<>]*)?\/?>/i;
/** A field's own value attribute, or "". */
const valueOf = (tag: string) => {
  const v = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return (v?.[1] ?? v?.[2] ?? v?.[3] ?? "").trim();
};
/** Whether a field's value or an option's is one: set, never empty, a reference or an expression. */
const heldValue = (value: string) => value !== "" && !REFERENCE.test(value) && !PLACEHOLDER.test(value) && !/^\{[^"'`]*\}$/.test(value);
/**
 * Whether a label's value follows it at `from` (memory-x6-1): the first text past blank and markup-only lines, as
 * pretty-printed HTML puts it ("<p>Your PIN:</p>\n\n<p>4821</p>"), unless it is another label ("Username:"), or a
 * field's own value ('<input type="password" value="Summer2024!">'), never an empty one, a reference or an expression
 * ('value=""', 'value="{{ form.password }}"', "value={password}"); a select's is its options' text or value. Past a
 * field with no value the rest of its line is read, a table's next cells on it too, and a word there shaped like a
 * password, or a PIN's digits after a PIN's label, is the label's ('<input type="password"> <small>(demo: Demo1234!)</small>'),
 * never the form's own words ("Sign in", "Remember me"): memory-y6-4. At most 400 characters are read, and markup
 * before the field that runs past them is taken to hold a value (fail closed).
 */
function valueAfterLabel(text: string, from: number, pin: boolean): boolean {
  const end = Math.min(text.length, from + 400);
  let beside = false;
  for (const m of text.slice(from, end).matchAll(/<[^<>]*>|<[^<>]*$|[^<]+|</g)) {
    const s = m[0];
    // A tag cut off or never closed, or a "<" in the text.
    if (s.startsWith("<") && !s.endsWith(">")) return !beside;
    if (s.startsWith("<")) {
      if (beside || !/^<(?:input|select)\b/i.test(s)) continue;
      if (heldValue(valueOf(s))) return true;
      if (/^<select\b/i.test(s)) {
        // Its options, up to the select's end (at most 2 KiB on, or it holds one).
        const at = from + m.index + s.length;
        const close = text.slice(at, at + 2048).search(/<\/select\b/i);
        if (close < 0) return true;
        for (const o of text.slice(at, at + close).matchAll(/<option\b[^<>]*>([^<]*)/gi)) if (heldValue(valueOf(o[0])) || heldValue(o[1]!.trim())) return true;
      }
      beside = true;
      continue;
    }
    if (beside) {
      const nl = s.indexOf("\n");
      const words = (nl < 0 ? s : s.slice(0, nl)).replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, " ").split(/\s+/)
        .map(w => w.replace(/^[("'“[<]+|[)"'”\],.;:>]+$/g, ""));
      if (words.some(w => secretShaped(w) || (pin && /^\d{4,12}$/.test(w)))) return true;
      if (nl >= 0) return false;
      continue;
    }
    const t = s.trim();
    if (t) return !/^[\p{L} ]{1,40}:$/u.test(t);
  }
  return !beside && end < text.length;
}
/**
 * Whether code after a prompt's string holds a word shaped like a password, or a comment after it does ('("Password:",
 * Summer2024!)', 'input("Password: ")  # Summer2024!'): memory-x6-1. A variable's name in the code is passed over.
 */
function valueAfterPrompt(after: string): boolean {
  const mark = after.search(/#|\/\//);
  const code = mark < 0 ? after : after.slice(0, mark);
  return code.split(/[\s,;()[\]{}+.]+/).some(w => secretShaped(w) && !codeLineName(w))
    || (mark >= 0 && after.slice(mark).split(/\s+/).some(w => secretShaped(w.replace(/[,.;:]+$/, ""))));
}
/** `text` with each prompt's or label's secret name (LABEL) written out as "_". */
function withoutLabels(text: string): string {
  return text.replace(LABEL, (m: string, at: number) => {
    const lineStart = text.lastIndexOf("\n", at) + 1;
    const nl = text.indexOf("\n", at);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    const rest = text.slice(at + m.length, lineEnd);
    const q = rest[0]!;
    // Inside a string that closes here, with only code after it, or a shell's read with its variable's name; or markup
    // after it and no text up to the field it labels.
    const after = rest.slice(1);
    const prompt = q !== "<"
      ? (text.slice(lineStart, at).split(q).length - 1) % 2 === 1 && !/["'`][^"'`\n]*\w[^"'`\n]*["'`]/.test(after)
        && (/^\s*(?:$|[),;+\]}]|\.\w|\/\/|#)/.test(after) || (/^\s*read\b/.test(line) && /^\s+[A-Za-z_]\w*\s*(?:;|$)/.test(after)))
        && !valueAfterPrompt(after)
      : HTML_TAG.test(rest) && !valueAfterLabel(text, at + m.length, /^(?:pin|passcode)/i.test(m));
    return prompt ? m.replace(/^[^:\s]+/, w => "_".repeat(w.length)) : m;
  });
}
/** A prompt's string, then a literal shaped like a password after it ('print("Password:", "hunter2")'): memory-r4-2. */
const PROMPT_THEN = /\b(?:pass(?:word|phrase|code)?|passwd|pwd|pin|passcode|token|secret|api[ _-]?key)s?[ \t]*:[ \t]*(["'`])\s*[,+]\s*(["'`])([^"'`\n]{3,80})\2/gi;
function promptThen(text: string): boolean {
  for (const m of text.matchAll(PROMPT_THEN)) if (secretShaped(m[3]!)) return true;
  return false;
}
/** The shell's working folder ("$PWD", "${PWD}", "$OLDPWD"), never a password. */
const SHELL_PWD = /\$\{?(?:OLD)?PWD\}?(?![\w])/g;

/**
 * An Authorization header that gives where its token comes from, not the token ("Authorization: Bearer $(gh auth
 * token)", "Bearer ${token}", "Bearer <token>"): its name, written out like a code key's (memory-r4-2).
 */
const AUTH_REFERENCE = /\bAuthorization(?=:\s*(?:Bearer|Basic|token)\s+(?:\$[({A-Z_]|\{\{|<[^<>\s]*>|\.{3}|…|x{3,}|\*{3,}|YOUR_|your[-_]))/gi;

/**
 * A value where a secret's would be: anything but a word like "required" (NOT_A_VALUE) or how long it is ("6 digits
 * long"), quoted or not.
 */
const VALUE = String.raw`["'“]?(?!(?:${NOT_A_VALUE})(?:[\s.,;!?"'”]|$))(?!\d{1,2}\s+(?:digits?|characters?|chars?|letters?|numbers?|words?)\b)\S+`;
/**
 * What may stand between a secret's name and "is": a short phrase that says what it is for ("for the HR portal", "at
 * home", "to unlock it"), a preposition and one to four words. A hyphen inside a word ("e-mail") isn't a separator.
 */
const FOR_WHAT = String.raw`(?:\s+(?:for|to|at|on|of|in|into|with|from)(?:\s+[^\s:=]+){1,4}?)?`;
/**
 * "is", "'s", "was", "are", "is:", or ":", "=", a spaced "-", "–" or "—" or one before a digit ("PIN-4821"), or ", it's"
 * and "? it's" ("my wifi password, it's BlueSky99": memory-i4).
 */
const SAYS_IS = String.raw`\s*[:=]|\s*[-–—](?=\s|\d)|['’]s\s|\s+(?:is|was|are|were)(?:\s*[:=])?\s`;
const SAYS_IT = String.raw`\s*[,?]\s*(?:it|that)(?:['’]s|\s+is)\s`;
const SAYS = String.raw`(?:${SAYS_IS}|${SAYS_IT})\s*`;
/**
 * SAYS before a value that may be a word: ", it's" only before one with a digit or a symbol ("my netflix password? it's
 * hunter2"), never "your password, it's personal" or "a long passphrase, it's easier to remember" (memory-v4-6).
 */
const SAYS_VALUE = String.raw`(?:${SAYS_IS}|${SAYS_IT}(?=\s*["'“]?[^\s"'”]{0,64}[0-9!@#$%^&*]))\s*`;

/**
 * "my password is…", "PIN: 1234", "the wifi key is…", "the password for the HR portal is…": a secret's name, perhaps
 * what it is for, then its value (not a word like "required"). A Wi-Fi password under the names Windows and routers
 * give it ("network security key", "WPA2 key", "pre-shared key", "PSK"), which Ember's screen reading already treats as
 * secret (perception/elements.ts), and a security question's answer however its owner is named ("the answer to the
 * user's security question is…"): safety-privacy-c4-2, memory-1.
 */
const SECRET_NAMES = String.raw`(?:pass(?:word|phrase|code|wd)|pw|pin|passcode|otp|2fa code|verification code|recovery (?:code|key|phrase|words)|puk|seed (?:phrase|words)|mnemonic|(?:bitcoin|btc|crypto|wallet|ethereum|eth|ledger|metamask) seed|unlock phrase|security (?:question )?answer|answer to (?:(?:my|the|a|your|our|their|his|her)\s+)?(?:[a-z]+['’]s\s+)?security question|cvv|cvc|wi-?fi (?:key|password)|network (?:security )?key|wpa[23]? (?:key|passphrase)|pre-?shared key|psk|wireless (?:network )?(?:key|password)|wlan (?:key|password)|wep key|api[ _-]?(?:key|token)|secret(?: access)?[ _-]?key)`;
/** Places that lock with a code ("door", "alarm", "garage", "safe"), for a code said as changed (CHANGED_MY). */
const PLACE_NAMES = String.raw`door|front door|back door|gate|garage|alarm|safe|lock|bike lock|locker|keypad|key ?safe|key ?box|lockbox|padlock|vault|building|entry|access|airbnb|gym|cabin|shed|mailbox|lift|elevator|house|home|office`;
/**
 * An adverb after "is" that says when, never the value ("My Wi-Fi password is now BlueSky99", "My password is still
 * hunter2", "The PIN is also 4821"), so "The password is now required" and "The PIN is now 6 digits" stay facts:
 * memory-r5-1.
 */
const NOW = String.raw`(?:(?:now|still|also|currently|actually|really|then|just)\s+)?`;
const TOLD_SECRET = new RegExp(
  String.raw`\b${SECRET_NAMES}s?\b(?:["'](?=\s*[:=]))?${FOR_WHAT}(?:\s+(?:everywhere|anywhere|here|there|now|too|also|always|usually|still|today|currently))?${SAYS_VALUE}${NOW}${VALUE}`,
  "i",
);
/**
 * A Wi-Fi key's state, where to look for it or its mode, after a router's name for the key, with no value in the rest
 * of its sentence ("PSK is enabled on the router", "Network key: see sticker", "PSK: rotated monthly", "The network key
 * is WPA2"): memory-r5-2. Only after these names, never a password's or a PIN's ("The admin password is rotated monthly,
 * currently Summer2024!", "PIN: active 4821"), and never with a word shaped like a value later in the sentence or on
 * the next line ("The VPN pre-shared key is configured to Tr0ub4dor&3", "Network key: see below\nBlueSky99"), but a
 * mode, a standard, a band, a size or a count ("WPA2-PSK", "802.11ac", "5GHz", "AES-256", "90 days"): memory-x6-2.
 * Nor with one straight after its sentence, perhaps after "it's" ("PSK: rotated. It's BlueSky99!", "WPA2 key: enabled;
 * BlueSky99!"), as a value after a password's state is read (STATE_THEN): memory-y6-2.
 */
const WIFI_KEY_NAMES = String.raw`network (?:security )?key|wpa[23]? (?:key|passphrase)|pre-?shared key|psk|wireless (?:network )?key|wlan key|wep key`;
const KEY_STATE = String.raw`enabled|disabled|configured|see|rotated|supported|active|inactive|unset|(?:wpa[23]?|wep|tkip)(?:[-/](?:psk|personal|enterprise|sae|aes|ccmp|tkip|wpa[23]?))*`;
const KEY_STATE_SAID = new RegExp(String.raw`\b(?:${WIFI_KEY_NAMES})s?\b(?=${FOR_WHAT}${SAYS}${NOW}(?:${KEY_STATE})(?![\w-])((?:[^.;!?]|[.;!?](?![\s"'”)]|$)){0,200})`
  + String.raw`(?:[.;!?]+["'”)]*\s+([^\n]{0,80}))?)`, "gi");
/** A Wi-Fi key's mode, standard, band or cipher, a size or a count, which are never its value. */
const NOT_A_KEY = /^(?:(?:wpa[23]?|wep|tkip|aes|ccmp|sae)(?:[-/][a-z0-9]+)*|802\.11[a-z]*|\d+(?:\.\d+)?(?:ghz|mhz|[kmg]bps)|\d+(?:-\d+)?-?(?:characters?|chars?|digits?|letters?|bits?|days?|weeks?|months?|hours?|minutes?)|\d{1,3}[dhwm])$/i;
/** The first word of the sentence after a Wi-Fi key's state, past the words that say it is the key ("It's", "the key is"). */
const NEXT_WORD = /^(?:(?:but|and|so|though|yet)\s+)?(?:(?:it|that)(?:['’]s|\s+is|\s+was)\s+|(?:the\s+)?(?:password|pin|code|value|key|passphrase|real\s+one)\s+is\s+)?(?:(?:now|currently)\s+)?(\S+)/i;
/** `text` with each Wi-Fi key's name written out as "_" where only its state follows (KEY_STATE_SAID). */
function withoutKeyStates(text: string): string {
  const value = (w: string) => w.length >= 4 && /[0-9!@#$%^&*]/.test(w) && !NOT_A_KEY.test(w);
  const bare = (w: string) => w.replace(/^[(["'“<]+|[)\]"'”>,:]+$/g, "");
  return text.replace(KEY_STATE_SAID, (m: string, rest: string, next: string | undefined) => rest.split(/\s+/).map(bare).some(value)
    || value(bare(NEXT_WORD.exec(next ?? "")?.[1] ?? "")) ? m : "_".repeat(m.length));
}
/**
 * A secret said as changed or to be ("I changed my password to Summer2024!", "The user's password was changed to …",
 * "The Netflix password changed to hunter2", "my password: changed it to hunter22", "remember I set my PIN to 4821",
 * "I updated the alarm code to 4821", "The password will be hunter2", "My password used to be hunter2"): memory-r5-1,
 * safety-privacy-1. After "changed to" a value with a digit or a symbol, or one word that ends the clause; after "will
 * be" or "used to be" only one with a digit or a symbol, so "The password should be easy to remember", "The password
 * changed to the new policy last week", "I changed my password manager to 1Password" and "Set the password to expire
 * every 90 days" stay facts.
 */
const NOT_A_CHANGE = String.raw`(?:${NOT_A_VALUE}|something|anything|nothing|one|whatever|mine|yours|default|expire|a\s+new)`;
const LENGTH_SAID = String.raw`\d+\+?[-\s]*(?:digits?|characters?|chars?|letters?|numbers?|words?|days?|weeks?|months?|minutes?|hours?)\b`;
const LENGTH = String.raw`(?!${LENGTH_SAID})`;
/** A length said before what it will be, which is read past ("The door PIN will be 4-digit 4821"): memory-y6-3. */
const LENGTH_FIRST = String.raw`(?:${LENGTH_SAID}[ \t]*[,;:]?[ \t]*(?:(?:it|that)(?:['’]s|\s+is)\s+)?)?`;
const CHANGE_VALUE = String.raw`["'“]?(?!${NOT_A_CHANGE}(?:[\s.,;!?"'”]|$))${LENGTH}(?:(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{3,}|[^\s"'”.,;!?]{3,}(?=["'”]?\s*(?:$|[.,;!?])))`;
const LATER_VALUE = String.raw`["'“]?(?!${NOT_A_VALUE}(?:[\s.,;!?"'”]|$))${LENGTH}(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{3,}`;
const CHANGE_TO = String.raw`\s*[:,–—-]?\s*(?:(?:has|have|had)\s+been\s+|(?:was|were|is|are|got|gets|been)\s+)?(?:just\s+|now\s+|recently\s+)?(?:changed|set|reset|updated|switched)(?:\s+(?:it|them))?\s+(?:back\s+)?to\s+`;
const LATER_BE = String.raw`\s+(?:(?:will|would|should|shall|must|might|could)(?:\s+now)?\s+be|is\s+going\s+to\s+be|used\s+to\s+be|became|becomes)\s+`;
const TOLD_CHANGE = new RegExp(String.raw`\b(${SECRET_NAMES})s?\b${FOR_WHAT}(?:${CHANGE_TO}(${CHANGE_VALUE})|${LATER_BE}${LENGTH_FIRST}(${LATER_VALUE}))`, "gi");
const CHANGED_MY = new RegExp(String.raw`\b(?:changed|change|set|reset|updated|update|switched|switch)\s+(?:(?:my|our|the|their|his|her|your|[a-z]+['’]s)\s+)?(?:[\w-]+\s+){0,3}?`
  + String.raw`(?:\b(${SECRET_NAMES})s?|(?:${PLACE_NAMES})\s+(?:code|combination|combo)s?)\s+(?:back\s+)?to\s+(${CHANGE_VALUE})`, "gi");
/** An API key's or a secret key's name, whose value is a token, never a word or code. */
const API_NAME = /^(?:api[ _-]?(?:key|token)|secret(?: access)?[ _-]?key)$/i;
/**
 * Whether `text` says a secret as changed or to be (TOLD_CHANGE, CHANGED_MY): an API key's only as a value shaped like
 * a token, never one word, a version or code where it goes ("Set the API key to staging", "Switch the API key to
 * read-only", "The API key was updated to v3.", "Set the API key to process.env.API_KEY"): memory-x6-5.
 */
function toldChange(text: string): boolean {
  for (const re of [TOLD_CHANGE, CHANGED_MY]) {
    for (const m of text.matchAll(re)) {
      const value = (m[2] ?? m[3] ?? "").replace(/^["'“]+|["'”.,;!?]+$/g, "");
      if (!API_NAME.test(m[1] ?? "") || (tokenShaped(value) && !/^(?:process\.env|import\.meta\.env|os\.environ|env|config|settings)\./i.test(value))) return true;
    }
  }
  return false;
}

/**
 * A password, passcode or passphrase with its value straight after ("VPN password hunter2", "the password 'Summer2024!'",
 * "HR portal pw Summer2024!", "Wi-Fi BlueSky, passphrase BlueSky99"): only a value with a digit or a symbol in it, so "password manager", "password reset" and "£500 pw for
 * the flat" are still words.
 */
const BARE_PASSWORD = new RegExp(
  String.raw`\b(?:pass(?:word|wd|code|phrase)|pwd|pw|wi-?fi\s+key)s?\s+["'“]?(?!(?:${NOT_A_VALUE})(?:[\s.,;!?"'”]|$))(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
  "i",
);
/**
 * An Indian postcode, which is called a "PIN code" ("Bengaluru, PIN code: 560001", "Our office PIN code is 560001", a line
 * "PIN Code - 560001" under an address): six digits, after an address earlier in its sentence (a word for a place, a
 * road, an Indian city or state) or, at the start of a line or a sentence, in the lines just before it, and with no word
 * for whose or what PIN it is near ("my", "card", "SIM", "garage", "profile"): memory-r3-3. Never after a bare comma
 * ("Garage, PIN code: 482193") or on a line with no address before it ("PIN code: 482193"): memory-v4-5.
 */
const PIN_POSTCODE = /\bpin\s*-?\s*code\s*(?:[:=]|-|\bis\b|\bwas\b)?\s*[1-9]\d{2} ?\d{3}(?![\d-])/gi;
/** Indian states, union territories and larger cities, which an address names before its PIN code. */
const INDIA = String.raw`india|pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|jharkhand|karnataka|kerala|maharashtra|manipur|`
  + String.raw`meghalaya|mizoram|nagaland|odisha|orissa|punjab|rajasthan|sikkim|tamil\s+nadu|telangana|tripura|uttarakhand|bengal|`
  + String.raw`andaman|nicobar|chandigarh|daman|diu|delhi|jammu|kashmir|ladakh|lakshadweep|puducherry|pondicherry|mumbai|bombay|bengaluru|`
  + String.raw`bangalore|hyderabad|secunderabad|ahmedabad|chennai|madras|kolkata|calcutta|pune|surat|jaipur|lucknow|kanpur|nagpur|indore|`
  + String.raw`thane|bhopal|visakhapatnam|vizag|patna|vadodara|baroda|ghaziabad|ludhiana|agra|nashik|noida|gurgaon|gurugram|faridabad|`
  + String.raw`kochi|cochin|coimbatore|mysuru|mysore|madurai|varanasi|amritsar|ranchi|guwahati|bhubaneswar|thiruvananthapuram|`
  + String.raw`trivandrum|mangaluru|mangalore|dehradun|jabalpur|raipur|vijayawada|kozhikode|calicut|udaipur|jodhpur|prayagraj|`
  + String.raw`allahabad|meerut|rajkot|srinagar|aurangabad|andheri|bandra|whitefield|koramangala`;
const ADDRESS_BEFORE = new RegExp(String.raw`\b(?:office|address|area|city|town|village|district|state|post|postal|located|branch|shop|store|delivery|shipping|billing|campus|road|street|nagar|colony|lane|marg|layout|sector|${INDIA})\b`, "i");
/** In the lines before a PIN code on its own line: an address's own words only ("12 MG Road", "Bengaluru"). */
const ADDRESS_LINES = new RegExp(String.raw`\b(?:address|city|town|village|district|state|road|street|nagar|colony|lane|marg|layout|sector|${INDIA})\b`, "i");
const WHOSE_PIN = /\b(?:my|your|his|her|their|user['’]s|card|bank|atm|debit|credit|sim|phone|mobile|account|unlock|lock|screen|voicemail|door|alarm|safe|passcode|password|secret|login|gate|garage|locker|keypad|vault|padlock|lockbox|wallet|profile|parental|netflix)\b/i;
/** `text` with each postcode called a "PIN code" written as "postcode", for the PIN checks only. */
function withoutPostcodes(text: string): string {
  return text.replace(PIN_POSTCODE, (m, at: number) => {
    const clause = text.slice(0, at).split(/[.;!?\n]/).at(-1)!;
    // At the start of a line or a sentence: the lines just before it say whether it is an address's.
    const before = clause.trim() ? clause : text.slice(Math.max(0, at - 120), at);
    const address = clause.trim() ? ADDRESS_BEFORE : ADDRESS_LINES;
    return !WHOSE_PIN.test(before.slice(-40)) && address.test(before) ? "postcode" : m;
  });
}
/**
 * A PIN with four or more digits straight after ("the phone unlock PIN 1379", "PIN number 4821", "PIN no. 4821", "my bank
 * PIN, 4821").
 */
const BARE_PIN = /\bpin(?:\s+(?:code|number|no\.?))?,?\s+\d{4,12}\b/i;
/**
 * "My PIN number is 1234", "PIN code: 1234", "the PIN number for my card is 1234", "my passcode number is 123456": the
 * commonest ways to say a PIN (memory-1), with four to twelve digits for its value, so "the LED pin number is 13" stays.
 */
const PIN_NUMBER = new RegExp(String.raw`\b(?:pin|passcode)\s+(?:code|number|no\.?)(?=[\s:=])${FOR_WHAT}${SAYS}${NOW}["'“]?\d(?:[-\s]?\d){3,11}\b`, "i");
/**
 * How long or how much a number is, after it ("12000 lines", "2024-ready", "32 characters"): never a code's digits.
 */
const NOT_DIGITS_OF_A_CODE = String.raw`(?![-–][A-Za-z]|\s+(?:lines?|loc|files?|bytes?|[kmg]b|words?|characters?|chars?|commits?|tests?|stars?|users?|downloads?|percent|ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|times?|apps?|screens?|pages?|steps?|pixels?|px)\b)`;
/**
 * A phone's, tablet's or laptop's code with its digits ("My phone code is 4821", "My phone's code is 4821", "the iPad code
 * is 482193"). A phone or an Android only as someone's own ("my phone code") or with a word for its lock, since "the phone
 * code for Leeds is 0113" is the number to dial and "Our Android code is 12000 lines long" is source code (memory-1,
 * memory-c3-1).
 */
const DEVICE_CODE = new RegExp(
  String.raw`\b(?:(?:my|his|her|their)\s+(?:mobile|cell|cellphone|smartphone|phone|android)|android(?=\s+(?:unlock|lock|screen))|iphone|ipad|tablet|laptop|macbook|kindle)(?:['’]s)?\s+(?:(?:unlock|lock|screen|lock\s+screen|screen\s+lock)\s+)?(?:code|pin|passcode)s?\b${FOR_WHAT}${SAYS}${NOW}["'“]?\d(?:[-\s]?\d){3,11}\b${NOT_DIGITS_OF_A_CODE}`,
  "i",
);
/**
 * A run a token could be: letters and digits both, twelve or more, ending where a word does ("abc123def456ghi789"). Never
 * a short name and a word joined by a hyphen ("HS256-signed", "base64url-encoded", "SHA-256-hashed", "32-characters"),
 * which says how a token is made (memory-c3-1).
 */
const TOKEN_RUN = String.raw`(?![A-Za-z0-9_+/=.-]{1,11}-[a-z]{3,}\.*(?![^\s"'”,;!?)]))(?=[A-Za-z0-9_+/=.-]*\d)(?=[A-Za-z0-9_+/=.-]*[A-Za-z])[A-Za-z0-9_+/=.-]{12,}(?![^\s"'”,;!?)])`;
/**
 * "The token for the API is abc123def456ghi789": a token's name, perhaps what it is for, then a run a token could be,
 * so "the access token is short-lived" and "the token count is 4096" stay facts (memory-1).
 */
const TOLD_TOKEN = new RegExp(String.raw`\btokens?\b${FOR_WHAT}${SAYS}["'“]?${TOKEN_RUN}`, "i");
/** A card's security code with its digits straight after ("…with CVV 123", "CVC 4821"). */
const BARE_CVV = /\b(?:cvv2?|cvc2?|csc)\s*(?:code|number)?\s*[:#]?\s*\d{3,4}\b/i;
/**
 * "Use hunter2 as the password for…", "uses hunter2 as their Netflix password", "hunter2 is my password", "4821 is my bank
 * PIN": a value said before the secret's name ("…as the PIN pad app" and "Bitwarden is my password manager" name no
 * password). A PIN with a word before it only with digits for its value, so "GPIO4 is the data pin" and "the ESP32 uses
 * GPIO0 as the boot pin" are wiring (memory-v4-6).
 */
const SECRET_ENDS = String.raw`s?(?=\s*$|[.,;!?]|\s+(?:for|on|at|to|of|in|with)\b)`;
const WHOSE = String.raw`(?:the|my|our|your|their|his|her)`;
const USED_AS = new RegExp(String.raw`\buses?\s+["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))(?:\d{4,12}["'”]?\s+as\s+(?:(?:${WHOSE}|a)\s+)?(?:[^\s.,;!?]+\s+)?(?:pass(?:word|phrase|code)|pin|pw)`
  + String.raw`|\S+["'”]?\s+as\s+(?:(?:${WHOSE}|a)\s+)?(?:(?:[^\s.,;!?]+\s+)?(?:pass(?:word|phrase|code)|pw)|pin))${SECRET_ENDS}`, "i");
const VALUE_FIRST = new RegExp(String.raw`(?:^|\s)["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))(?:\d{4,12}["'”]?\s+is\s+${WHOSE}\s+(?:[^\s.,;!?]+\s+)?(?:pass(?:word|phrase|code)|pin|pw)`
  + String.raw`|(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}["'”]?\s+is\s+${WHOSE}\s+(?:[^\s.,;!?]+\s+)?(?:pass(?:word|phrase|code)|pw))${SECRET_ENDS}`, "i");
/**
 * A login with its user name and password together ("Login for the router: admin / P@ssw0rd", "credentials for staging
 * are admin and hunter22"): only when the second has a digit or a symbol, so "Login for the wiki is via SSO and Okta"
 * stays a fact.
 */
const LOGIN_PAIR = new RegExp(
  String.raw`\b(?:login|log-in|sign-in|credentials?|creds)\b${FOR_WHAT}${SAYS}["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))\S+\s*(?:/|,|\band\b|\bwith\b)\s*["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
  "i",
);
/**
 * A login or credentials said as one value with a digit or a symbol, the way the model writes a fact ("The user's
 * Netflix login is hunter2", "The user's Netflix credentials: hunter2": safety-privacy-1). A login only with "is" or
 * "was" ("login: user1" in a file names a user), and the value where what is said ends, so a user name, an email or web
 * address, a variable ("credentials: ${{ secrets.DEPLOY_KEY }}"), a protocol or an encoding ("the login is OAuth2", "the
 * credentials are base64"), a time, a date or a year ("Last login was 10:30", "the login is 10am-6pm"), a status ("Login
 * is 404ing") and how it is made ("the credentials are AES-256 encrypted", "the login is 2FA-protected") stay facts. So do
 * a user at a computer named by its address or as localhost ("deploy@10.0.0.5", "admin@localhost"), a handle with no digit
 * ("@octocat"), a host with its port and perhaps a path ("localhost:8080", "localhost:3000/login") and an environment
 * variable in code ("process.env.AWS_CREDS_V2"):
 * safety-privacy-v4-1. A user at a computer named otherwise ("admin@nas1") is written as a password often is ("P@ss-w0rd",
 * "Tr0ub@dor-3"), so it is refused, as a user name with a digit is (fail closed), unless its port is given or the
 * user's and the computer's names are words ("user@host:2222", "jsmith@corp", never "p4ss@word": memory-v5-4); a version,
 * an issue and a setting stay facts too ("v2.0", "#142", "AWS_PROFILE=dev2": safety-privacy-c4-3), a setting only when its
 * name says no secret and its value isn't shaped like one (`toldLogin`; never "MY_PASS=hunter2": memory-v5-4).
 */
const AUTH_SCHEME = String.raw`oauth|saml|fido|ntlm|ntlmv|kerberos|krb|ldaps?|openid|oidc|u2f|webauthn|totp|hotp|2fa|mfa|sso|pkce|tls|ssl|base|sha|md5|aes|rsa|hmac|utf|jwt|x509`;
const LOGIN_VALUE = String.raw`["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))(?![^\s@"'”]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[\s.,;!?"'”]|$))`
  + String.raw`(?![a-z_][\w.-]*@(?:\d{1,3}(?:\.\d{1,3}){3}|localhost)(?::\d{1,5})?(?:[\s.,;!?)"'”]|$))(?!@[a-z_][a-z_.-]*(?:[\s.,;!?)"'”]|$))`
  + String.raw`(?![a-z_][\w.-]*@[a-z0-9][\w.-]*:\d{1,5}(?:[\s.,;!?)"'”]|$))(?![a-z][a-z._-]+@[a-z][a-z-]*(?:[\s.,;!?)"'”]|$))`
  + String.raw`(?!v\d+(?:\.\d+)*(?:[-+][\w.]+)?(?:[\s.,;!?)"'”]|$))(?!#\d+(?:[\s.,;!?)"'”]|$))`
  + String.raw`(?!(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}):\d{1,5}(?:\/[\w./-]*)?(?:[\s.,;!?)"'”]|$))(?!(?:process\.env|import\.meta\.env|os\.environ|env)[.[])`
  + String.raw`(?![a-z][a-z0-9+.-]*:\/\/|www\.)(?![$%{])(?!(?:${AUTH_SCHEME})\d*(?:[\s.,;!?"'”]|$))(?!(?:19|20)\d\d(?:[\s.,;!?"'”]|$))`
  + String.raw`(?!\d{1,4}(?:[-/:.]\d{1,4})+(?:am|pm)?(?:[\s.,;!?"'”]|$))(?!\d{1,2}(?::\d\d)?\s?(?:am|pm)\b)(?!\d+(?:ing|ed|s)\b)(?![^\s"'”]{1,11}-[a-z]{3,}(?:[\s.,;!?"'”]|$))`
  + String.raw`(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}["'”]?(?=\s*(?:$|\n)|[.,;!?)]|\s+[-–—]|\s+(?:and|but|so|for|on|at|to|in|with|from|which|if|or)\b)`;
const TOLD_LOGIN = new RegExp(
  String.raw`\b(?:(?:login|log-in|sign-in)\b${FOR_WHAT}\s+(?:is|was)\s+|(?:credentials?|creds)\b${FOR_WHAT}(?:\s*[:=]\s*|\s+(?:is|are|was|were)(?:\s*[:=])?\s+))(?<value>${LOGIN_VALUE})`,
  "gi",
);
/** Whether `text` says a login as TOLD_LOGIN reads one, but a setting that names no secret with a value not shaped like one. */
function toldLogin(text: string): boolean {
  for (const m of text.matchAll(TOLD_LOGIN)) {
    const setting = /^["'“]?([A-Za-z][A-Za-z0-9_]*)=([^\s"'”]*?)["'”]?$/.exec(m.groups!.value!);
    if (!setting || SECRET_IN_NAME.test(setting[1]!) || secretShaped(setting[2]!)) return true;
  }
  return false;
}
/**
 * An admin's or root's user name and password ("Jenkins admin: admin / j3nkins!"): only with a spaced slash between and a
 * digit or a symbol in the second, so "root: /opt/app2" and "the admin is Priya, with Bob as backup" stay (memory-1).
 * Never with a size, a number or a path for the user name, so a disk's use ("Root: 45G / 100G") stays (memory-c4-2), and
 * after "=" only outside code: never after const or let, before a ";" that ends its line (looked for in the next 200
 * characters, so a long line stays linear), or with a number or a bracket after the slash ("const root = -b / (2*a);",
 * "root = width / 2000"), but "Admin = admin / hunter2!" (memory-v5-4). After "=" the user name is an account's, admin,
 * root or a capitalised name ("Priya"), never a variable, so a path or a division stays code ("root = tmp_path /
 * \"out1\"", "root = BASE_DIR / \"static2\"", "root = sum / count2": memory-w5-5).
 */
const ADMIN_PAIR = new RegExp(
  String.raw`\b(?:admin|administrator|root)\b${FOR_WHAT}(?!\s*=)${SAYS}["'“]?(?![\d(+\-–—~.])[^\s/]+\s+/\s+["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
  "i",
);
const ADMIN_SET = new RegExp(
  String.raw`(?<!\b(?:const|let|var|val|final|static|auto|int|float|double|local)\s+)\b(?:[Aa]dmin(?:istrator)?|ADMIN(?:ISTRATOR)?|[Rr]oot|ROOT)\s*=(?![^\n;]{0,200};[ \t]*(?:\n|$))\s*`
  + String.raw`["'“]?(?:admin|administrator|root|[A-Z][a-z]+)["'”]?\s+/\s+["'“]?(?![\d.]+(?:[\s,)]|$))(?![^\s"'”]*[()])(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
);
/** "Wifi: BlueSky99": the network's key, only with a digit or a symbol in it ("Wifi: slow" is a fact). */
const WIFI_KEY = /\bwi-?fi\b\s*[:=]\s*["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{6,}/i;
/**
 * A value after a word for a secret's state and a comma or a full stop ("PIN: entered, 4821", "Password: masked, but
 * it's hunter2", "password: typed. BlueSky99", "Password: hidden, it's hunter2"): the state isn't its value, but
 * what follows it may be: memory-r5-3. Only a value with a digit or a symbol, never a length or a count ("The password
 * is required, 12 characters", "The PIN is required, 4-digit") or how it is hashed or encrypted ("Passwords are hashed,
 * SHA-256", "Password: hashed, argon2id": memory-x6-5), so "Passwords are hashed. Tokens are rotated." and "Password:
 * masked, PIN: entered" stay. A length or an algorithm is read past to what follows it ("The PIN is required, 4-digit,
 * 4821", "Password: hashed, SHA-256, but it's Summer2024!"), and an algorithm's or an encoding's name ends a word
 * ("SHA-256,", "base64-encoded"), so "Rs2024!" is a value: memory-y6-3.
 */
const STATE_LENGTH = String.raw`\d+\+?[-\s]*(?:digits?|characters?|chars?|letters?|numbers?|words?|days?|weeks?|months?|years?|minutes?|hours?|seconds?|times|attempts|tries)\b`;
const STATE_ALGORITHM = String.raw`(?:(?:sha|aes|rsa|des|md|hs|rs|es|ps|blake|crc)-?\d+|argon2(?:id|i|d)?|bcrypt\w*|pbkdf2\w*|base(?:16|32|58|64)(?:url)?|utf-?(?:8|16))`
  + String.raw`(?:-(?:hashed|encoded|encrypted|signed|salted|based))?(?![^\s"'”,.;:)])`;
const STATE_THEN = new RegExp(String.raw`\b${SECRET_NAMES}s?\b${FOR_WHAT}${SAYS}${NOW}[A-Za-z][A-Za-z'’-]*[ \t]*[,;.][ \t]*`
  + String.raw`(?:(?:${STATE_LENGTH}|${STATE_ALGORITHM})[ \t]*[,;:]?[ \t]*)?(?:(?:but|and|so|though|yet|which\s+is)\s+)?`
  + String.raw`(?:(?:it|that)(?:['’]s|\s+is|\s+was)\s+|(?:the\s+)?(?:password|pin|code|value|real\s+one)\s+is\s+)?["'“]?`
  + String.raw`(?!${STATE_LENGTH})(?!${STATE_ALGORITHM})(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`, "i");
/**
 * A network and its key said together ("Guest Wi-Fi: BlueSky / BlueSky99", "Home network: BlueSky, key BlueSky99"),
 * the key with a digit or a symbol: safety-privacy-c4-2. Never its router's address, its standard, its mode or its band
 * ("Home network: HomeNet / 192.168.1.1", "Wi-Fi: HomeNet, 802.11ac", "Wi-Fi: HomeNet / WPA2-PSK"), which may come before
 * the key ("Wi-Fi: HomeNet / WPA2-PSK, key BlueSky99"): memory-x6-5. Up to six of them may ("Wi-Fi: HomeNet / WPA2-PSK /
 * 5GHz / BlueSky99!"), and after the router's address its user ("Home network: HomeNet / 192.168.1.1 / admin /
 * Summer2024!"): memory-y6-3.
 */
const NETWORK_SETTING = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?|802\.11[a-z]*|(?:wpa[23]?|wep|tkip|aes|ccmp|sae)(?:[-/][a-z0-9]+)*|\d+(?:\.\d+)?\s?(?:ghz|mhz|[kmg]bps))`;
const NETWORK_PAIR = new RegExp(String.raw`\b(?:wi-?fi|wlan|wireless|(?:home|guest|office|work)\s+network)\b\s*[:=]\s*\S+\s*(?:\/|,)\s*(?:${NETWORK_SETTING}\s*[,/]?\s*){0,6}`
  + String.raw`(?:(?<=\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\s*[,/]?\s*)[A-Za-z][\w.-]{0,31}\s*[,/]\s*)?`
  + String.raw`(?:(?:key|password|pass|pw|passphrase|psk)\s+)?["'“]?(?!${NETWORK_SETTING}(?:[\s.,;!?)"'”]|$))(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{6,}`, "i");
/**
 * A service a person signs in to and a value shaped like a password straight after its name ("Netflix: hunter2", "The
 * user's Gmail: Tr0ub4dor&3", "The user's Netflix account: hunter2", "Netflix login hunter2"): safety-privacy-1. Never a
 * site where an account is a public handle (GitHub, Instagram), nor an address, a plan or a size ("Gmail:
 * priya2@gmail.com", "Netflix: 4K plan").
 */
const SERVICE_VALUE = new RegExp(String.raw`\b(?:netflix|spotify|hulu|disney\+?|amazon|prime\s+video|gmail|outlook|hotmail|yahoo|icloud|apple\s+id|paypal|venmo|ebay|steam|xbox|playstation|psn|nintendo|uber|airbnb|dropbox|facebook|online\s+banking|bank)`
  + String.raw`(?:(?:\s+(?:account|login|sign-in))?\s*:\s*|\s+(?:login|sign-in)\s+)["'“]?([^\s"'”]{6,})`, "gi");
function serviceValue(text: string): boolean {
  for (const m of text.matchAll(SERVICE_VALUE)) if (secretShaped(m[1]!.replace(/[.,;!?)]+$/, ""))) return true;
  return false;
}
/**
 * A capitals setting for a password ("DB_PASS=Tr0ub4dor&3"), a value with a digit or a symbol, never a reference: memory-1.
 * Never a filter's or a renderer's pass ("LOW_PASS=8000", "HIGH_PASS: 2000", "RENDER_PASS=shadow2"): memory-x6-5.
 */
const SHOUTED_PASS = /\b(?!(?:LOW|HIGH|BAND|ALL|RENDER)_PASS\b)[A-Z][A-Z0-9]*_PASS\s*[:=]\s*["']?(?![$%{<])(?=[^\s"']{0,64}[0-9!@#$%^&*])[^\s"']{4,}/;
/**
 * A secret's name, then another label and a value shaped like a password, as a mapping reads once its lines are run
 * together, the way memory keeps a fact ("credentials: admin: Wint3r!Sh0p", "Wi-Fi: home: BlueSky99"), never a
 * setting's label or a size ("Wi-Fi: SSID: Home5G", "Wi-Fi: speed: 300Mbps"): safety-privacy-r5-1.
 */
const NESTED_SECRET = /\b(?:credentials?|creds|wi-?fi|passwords?|passphrases?|secrets?|tokens?|logins?|psk)\b\s*[:=]\s*([\w.-]{2,40})\s*[:=]\s*["'“]?([^\s"'”`:]{4,})(?![`:])/gi;
function nestedSecret(text: string): boolean {
  for (const m of text.matchAll(NESTED_SECRET)) {
    if (words(m[1]!).some(w => SETTING_WORDS.test(w))) continue;
    const v = m[2]!.replace(/[.,;!?)]+$/, "");
    if (secretShaped(v) && !/^\d+(?:\.\d+)?[A-Za-z%]{0,5}$/.test(v)) return true;
  }
  return false;
}
/**
 * A secret's name and a literal for it written as a pair, wherever the name sits (safety-privacy-r5-1): a call's two
 * strings ("define('DB_PASSWORD', 'Wint3r!Sh0p')", 'props.setProperty("password", "…")'), an index assigned ("$config[
 * 'password'] = '…'", "os.environ['PASSWORD'] = '…'"), an XML element ("<password>…</password>", Maven's settings.xml)
 * or a key and its value as attributes ('<add key="Password" value="…" />'). Never a reference, a placeholder, a
 * template's field, an empty string or a sentence ("<password>${env.PW}</password>", "<password>{password}</password>",
 * "define('DB_PASSWORD', getenv('DB_PASSWORD'))").
 */
const PAIR_NAME = String.raw`[\w.$-]{0,64}?(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)s?`;
const SECRET_PAIRS = [
  new RegExp(String.raw`\b(?:define|setProperty|setenv|putenv|put|set|setItem|add|Add|setdefault|SetEnvironmentVariable|SetValue)\s*\(\s*(["'])${PAIR_NAME}\1\s*,\s*(["'\`])((?:(?!\2)[^\n\\]|\\.){1,200})\2`, "gi"),
  new RegExp(String.raw`\[\s*(["'])${PAIR_NAME}\1\s*\]\s*(?:=|:=)\s*(["'\`])((?:(?!\2)[^\n\\]|\\.){1,200})\2`, "gi"),
  new RegExp(String.raw`<((?:[\w.-]+:)?${PAIR_NAME})(?:\s[^<>]*)?>([^<\n]{1,200})</\1>`, "gi"),
  new RegExp(String.raw`\b(?:key|name)\s*=\s*(["'])${PAIR_NAME}\1\s+value\s*=\s*(["'])((?:(?!\2)[^\n]){1,200})\2`, "gi"),
];
function secretPair(text: string): boolean {
  for (const re of SECRET_PAIRS) {
    for (const m of text.matchAll(re)) {
      const v = (m.length > 3 && m[3] !== undefined ? m[3] : m[2]!).trim();
      // A template's field ("{password}", "%(password)s", "@DB_PASSWORD@", "__TOKEN__") is a reference too.
      if (/\w/.test(v) && !PLACEHOLDER.test(v) && !REFERENCE.test(v) && !/^\$\{|^\$[A-Za-z_]|^%[A-Za-z_]/.test(v) && !sentence(v)
        && !/^(?:\{[A-Za-z_][\w.]*\}|%\(\w+\)[sd]|@\w+@|__\w+__)$/.test(v)) return true;
    }
  }
  return false;
}
/**
 * A seed phrase on its own ("seed: abandon ability able about above absent", "Seed: …"): six or more lowercase words, so
 * "Seed: Use The Fixtures First" is a heading (memory-1).
 */
const SEED_WORDS = /\b[Ss]eed\b\s*(?::|=|\bis\b)\s*(?:[a-z]+\s+){5,}[a-z]+/;
/**
 * "user priya, pass hunter2": "pass" as a password, but only after a user name or login, since it is a common word, and
 * with a digit or a symbol in its value unless a ":" or "=" says it is one ("so we pass our own object" is a verb), or as
 * the last word straight after "user" and a name ("username bob pass hunter", never "the user should pass validation"
 * or "make the user tests pass again": memory-v5-4). The name is quoted, before a comma, after "username" or not a
 * lowercase plural, and the word isn't one for a check ("-ing", "-tion", "-sion", "-ment"), so "Why don't the user
 * scripts pass linting?" and "Ensure user inputs pass sanitisation." stay (memory-w5-4).
 */
const PASS_NOT_USER = String.raw`should|must|can|could|will|would|may|might|shall|to|do|does|did|doesn['’]t|don['’]t|didn['’]t|can['’]t|won['’]t|cannot|needs?|has|have|had|is|was|are|and|or|then|also|always|never|who|that|which|gets?|got|input|data|tests?|checks?|requests?|sessions?|ids?|names?|accounts?|records?|objects?|info|details|credentials|creds|events?|flows?|stories|story`;
const PASS_NOT_VALUE = String.raw`again|now|through|on|by|it|them|this|that|the|a|an|all|fine|locally|validation|review|tests?|ci|checks?|over|along|away|out|up|down|in|back|around|here|there|first|too|also|today|anyway|either|though|yet|muster|ok|okay|safely|correctly|properly|cleanly|green|unchanged|null|none|true|false|undefined|args|arguments|params|parameters|data|values?|control|ownership|context|state|props|everything|anything|nothing|both|well|quickly|later|soon|instead`;
const LOGIN_PASS = new RegExp(String.raw`\b(?:user(?:name)?|login)\b[^\n]{0,60}?\bpass\b(?:\s*[:=]\s*["'“]?|\s+["'“]?(?=[^\s"'”,;]{0,64}[0-9!@#$%^&*]))[^\s"'”,;]{3,}`, "i");
const USER_PASS = new RegExp(String.raw`\buser(?<username>name)?\s+(?<user>["'“][\w.@-]{2,}["'”]|(?!(?:${PASS_NOT_USER})\b)[\w.@-]{2,})(?<comma>,?)\s+pass\s+["'“]?`
  + String.raw`(?!(?:${PASS_NOT_VALUE})\b)(?![A-Za-z]*(?:ing|tion|sion|ment)\b)[A-Za-z]{3,}["'”]?(?=\s*(?:$|\n|[.,;!?)]))`, "gi");
/** Whether `text` gives a user's name and password (LOGIN_PASS, USER_PASS), never a lowercase plural after "user" alone. */
function loginPass(text: string): boolean {
  if (LOGIN_PASS.test(text)) return true;
  for (const m of text.matchAll(USER_PASS)) {
    const { username, user, comma } = m.groups!;
    if (username || comma || !/^[a-z]+[^s\W]s$/.test(user!)) return true;
  }
  return false;
}
/**
 * A code or combination for a door, alarm, safe and the like, with digits for its value ("the door code is 4821",
 * "Garage code: 7734", "backup codes are 1234-5678", "the safe combination is 32-18-04"). "The door code changes on
 * Monday" and "the access code for the conference is on the invite" have no digits where the value would be. A house's,
 * a home's or an office's own code locks it ("my house code is 4821": memory-i4), only as someone's or "the" one ("the
 * office code is 4821"), never a post office's, a branch or head office's, a box office's or in-house source code
 * ("Post office code: 560001", "Our in-house code is 2000 lines long": memory-v4-3); with another word between ("our
 * office ZIP code is 90210", "the house style code 123") only a word for its lock counts (memory-r6).
 */
const OWN_PLACE = String.raw`(?:my|our|your|his|her|their|the|[a-z]+['’]s)\s+(?:house|home|office)`;
// Places let or shared by a code ("the Airbnb code is 4821", "the gym code", "the storage unit code"): memory-1.
const PLACES = String.raw`door|front door|back door|gate|garage|alarm|safe|lock|bike lock|locker|entry|access|backup|one-time|recovery|unlock|security|building|keypad|key ?safe|key ?box|lockbox|padlock|vault|flat|apartment|`
  + String.raw`airbnb|gym|cabin|cottage|chalet|caravan|shed|storage unit|storage locker|mailbox|letterbox|lift|elevator|${OWN_PLACE}`;
/** Places that only lock, so a code for one is a lock's whatever word comes before it ("the bank code for the vault"). */
const LOCKS = String.raw`door|front door|back door|side door|gate|garage|alarm|safe|bike lock|locker|keypad|key ?safe|key ?box|lockbox|padlock|vault`;
/**
 * What may stand between a place and its code: only a word for what opens it ("garage opener code", "building entry
 * code"), never any word, so "the access control code 401", "backup exit code 255" and "a security error code 403" stay
 * (memory-r6).
 */
const LOCK_WORDS = String.raw`door|front door|back door|side door|entry|entrance|check-?in|alarm|keypad|lock|opener|remote|gate|access|unlock|security|key ?safe|lockbox|padlock`;
const PLACE_CODE = new RegExp(
  // "keycode" is one on its own.
  // "The access code 401 errors" and "the security code 403 error" name an HTTP status (memory-r6).
  String.raw`\b(?:(?:${PLACES})(?:\s+(?:${LOCK_WORDS}))?\s+(?:code|combination|combo|pin)s?|key ?codes?|door ?codes?)\b${FOR_WHAT}(?:${SAYS}${NOW}|${CHANGE_TO}|${LATER_BE}|\s+)["'“]?#?\d(?:[-\s]?\d){2,}(?![\d-]|\s*(?:errors?|status|responses?|forbidden|unauthori[sz]ed|http)\b)`,
  "i",
);
/** Codes that open nothing, whatever place they are for ("the area code for the building is 0113"): memory-r6. */
const NOT_A_LOCK = String.raw`area|zip|postal|post|cost|project|status|error|exit|timeout|dial|dialling|dialing|permit|mode|phone|country|tax|product|discount|promo|voucher|coupon|tracking|reference|booking|course|class|style|source|room|department|billing|account|sort|branch|bank|swift|flight|airport|zone|extension|colour|color|centre|center`;
/**
 * The code or combination first, then what it opens ("the code for the front door is 4821", "the combination to my bike
 * lock is 1234", "the code to the safe is 32-18-04", "the code to get into the office is 4821"), with digits for its
 * value. "The area code for London is 020" names no place that locks, "the area code for the office is 0113" a code that
 * opens nothing, and "the code for the report is in GitHub" has no digits. A vault, a safe or a door only locks, so its
 * code is one after any word ("the bank code for the vault is 4821": safety-privacy-c3-1).
 */
const CODE_FOR_PLACE = new RegExp(
  String.raw`(?:(?<!\b(?:${NOT_A_LOCK})\s+)\b(?:code|combination|combo|pin|keycode)s?\s+(?:for|to|of|at|on)\s+(?:[^\s:=]+\s+){0,3}?(?:${PLACES})`
  + String.raw`|\b(?:code|combination|combo|pin|keycode)s?\s+(?:for|to|of|at|on)\s+(?:[^\s:=]+\s+){0,3}?(?:${LOCKS}))\b${SAYS}["'“]?#?\d(?:[-\s]?\d){2,}`,
  "i",
);
/** A social security number beside its name ("my SSN is 123-45-6789", "social security number 123 45 6789"). */
const SSN = /\b(?:ssn|social security(?: number| no\.?)?)\b[^\d\n]{0,20}\d{3}[- ]?\d{2}[- ]?\d{4}\b/i;
/** A run shaped like an IBAN (country, check digits, 11 to 30 letters and digits, spaces allowed), checked by mod 97. */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;

/** A private key's armour header ("-----BEGIN OPENSSH PRIVATE KEY-----"), on its own: refused without its END line. */
const PRIVATE_KEY_START = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/i;

/** A run of 13 to 19 digits (spaces or dashes between groups) that passes the Luhn check: a payment card. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Whether `run` (spaces dropped) starts with a valid IBAN of 15 to 34 characters (ISO 13616: mod 97 is 1). */
function iban(run: string): boolean {
  const all = run.replace(/ /g, "");
  for (let n = Math.min(all.length, 34); n >= 15; n--) {
    const s = all.slice(4, n) + all.slice(0, 4);
    let mod = 0;
    for (const ch of s) {
      const v = ch >= "A" ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
      mod = (v >= 10 ? mod * 100 + v : mod * 10 + v) % 97;
    }
    if (mod === 1) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Why `text` may not be remembered, in a few words for the model to pass on, or null when it may. */
export function memoryRefusal(text: string): string | null {
  // Code where a value would be names no secret (memory-r4-1, memory-r4-2): its names are written out first, its values kept.
  const found = { held: false };
  const said = withoutKeyStates(withoutCodeKeys(withoutLabels(text.replace(AUTH_REFERENCE, "_").replace(SHELL_PWD, "_")), found));
  const probe = said.replace(NAMED_NO_VALUE, " ");
  if (found.held || redactSecrets(probe) !== probe || secretPair(text) || promptThen(text)) return "it holds a password, token or key";
  // The redactor hides a key only with its END line too: a key's first line alone is still a key's start (audit).
  if (PRIVATE_KEY_START.test(text)) return "it holds a private key";
  const pins = withoutPostcodes(said);
  if (TOLD_SECRET.test(said) || BARE_PASSWORD.test(said) || BARE_PIN.test(pins) || loginPass(said) || PLACE_CODE.test(said)
    || CODE_FOR_PLACE.test(said) || BARE_CVV.test(said) || USED_AS.test(said) || LOGIN_PAIR.test(said) || WIFI_KEY.test(said) || SEED_WORDS.test(said) || nestedSecret(said)
    || PIN_NUMBER.test(pins) || DEVICE_CODE.test(said) || TOLD_TOKEN.test(said) || ADMIN_PAIR.test(said) || ADMIN_SET.test(said) || VALUE_FIRST.test(said)
    || toldChange(said) || NETWORK_PAIR.test(said) || serviceValue(said) || SHOUTED_PASS.test(said) || STATE_THEN.test(said)) {
    return "it holds a password, PIN or code";
  }
  // Said as a login's one value, it may be the user name ("my login is jsmith42"): the model is told it may be the
  // password, never that it is one (safety-privacy-v4-1).
  if (toldLogin(said)) return "a login said that way may be its password";
  for (const m of text.match(CARD) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) return "it holds a card number";
  }
  if (SSN.test(text) || (text.match(IBAN) ?? []).some(iban)) return "it holds an account or ID number";
  return null;
}
