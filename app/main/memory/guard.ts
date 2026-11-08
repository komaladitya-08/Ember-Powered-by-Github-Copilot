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
 * "Password: changed yesterday"): a value is anything else ("hunter2", "correct-horse").
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
/** A property that holds the secret itself ("password.value = …"); any other is about it ("token.type", "tokens.length"). */
const VALUE_PROPERTY = /^(?:value|val|text|raw|data|content|plain|plaintext|str|string|hash|secret|key)$/i;
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
/**
 * Whether `s`, a block's first line, is a statement written as code: one that ends as a block's or a call's line does,
 * or a keyword alone or before one name or call ("return creds", "pass"), never "default is admin123" (memory-v5-3).
 */
const codeStatement = (s: string) => CODE_STATEMENT.test(s)
  && (/[:({;)\]]\s*$/.test(s) || /^[a-z]+(?:\s+[A-Za-z_$][\w$.]*(?:\([^()]*\))?)?$/.test(s));
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
    && (secretShaped(s) || /(?:\|\||\?\?|\bor|\?|:-)\s*$/.test(before) || (depth === 0 && /(?<![=!<>])=\s*$/.test(before))
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
 * code unless shaped like a password, whether typeof reads it ("typeof token === …"), and whether it is a shell's
 * variable, whose unquoted value is a literal ("export DB_PASSWORD=changeme"), never a name (memory-v5-2).
 */
interface CodeKey { name: string; count: boolean; pin: boolean; compared: boolean; typeOf: boolean; shell: boolean }

/** Whether `v`, what follows a secret-named key's ":" or "=" on `line`, reads as code rather than a value. */
function readsAsCode(key: CodeKey, v: string, line: string, op = "="): boolean {
  if (TYPE_ALIAS.test(line)) return true;
  if (holdsLiteral(v)) return false;
  // A word with a digit or a symbol in brackets or after a comment's mark is a value written that way ("(hunter2)",
  // "<P@ss>", "[Summer2024, Winter2025]", "# hunter2"), unless a line of code names a variable so ("[node1]").
  const bracket = /^(?:[([{<]|\/\/|\/\*|#)([^()[\]{}<>\n]{0,80})/.exec(v)?.[1];
  const valueWord = (w: string) => !/^["'`]/.test(w) && !/[_.(]/.test(w) && (/[!@#$%^&*]/.test(w) || (/[A-Za-z]/.test(w) && /\d/.test(w)));
  if (bracket !== undefined && bracket.split(/[\s,;|:=]+/).some(w => valueWord(w) && !(CODE_LINE.test(line) && /^[([]/.test(v) && codeLineName(w)))) return false;
  // A comment, a bracket with code in it, a regular expression, a reference, a YAML tag or a borrow ("&str", "&[u8]")
  // where the value would be; never YAML's block markers ("|", ">"), whose value is on the lines after.
  if (/^(?:\/\/|\/\*|#\s|\/[\^([\\]|&(?:str\b|mut\b|self\b|\[|'|[A-Z][A-Za-z]*\b(?!\d))|![A-Za-z]+\s+\S)/.test(v) || REFERENCE.test(v)) return true;
  if (/^[([{<]/.test(v)) return codeInBracket(v, line, op);
  const quoted = /^(["'`])(.*?)\1/.exec(v);
  if (quoted) {
    const s = quoted[2]!;
    // A type's string values ('"password" | "text"'), what typeof gives in a comparison, and one or two characters.
    return s === "" || PLACEHOLDER.test(s) || REFERENCE.test(s) || VERSION.test(s) || /^(?:\.{1,2}|~)\//.test(s)
      || (!key.pin && (/^[^\w\s]{1,3}$/.test(s) || s.length <= 2)) || (quoted[1] === "`" && s.includes("${"))
      || (key.compared && !secretShaped(s)) || /^\s*\|\s*["'`]/.test(v.slice(quoted[0].length))
      || (key.typeOf && /^(?:string|number|boolean|object|undefined|function|symbol|bigint)$/.test(s));
  }
  if (/^["'`]/.test(v)) return false;
  const word = /^[^\s,;)\]}"'`]+/.exec(v)?.[0] ?? "";
  // A setting's own name and a value that isn't shaped like a password ("AWS_PROFILE=dev2").
  const setting = /^[A-Z][A-Z0-9]*_[A-Z0-9_]*=([^\s,;]*)/.exec(v);
  if (PLACEHOLDER.test(word) || (key.shell ? SHELL_CODE.test(v) : CODE_TYPE.test(v) || CODE_WORD.test(v)) || (setting && !secretShaped(setting[1]!))) return true;
  // A negated member ("!!n.secret", "!opts.token").
  if (!key.shell && /^!!?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+/.test(v)) return true;
  const num = /^-?(?:0x[0-9a-f]+|\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?)(?![\w$@.!#%&*:/-])/i.exec(v)?.[0];
  // After a prose label's ":", only a one- or two-digit number, never "Password: 0xCAFE" (memory-v5-3).
  const short = op === ":" && !codeish(line) ? /^\d{1,2}$/ : /^-?(?:\d{1,2}|0x[0-9a-f]{1,4}|\d*\.\d+(?:e[-+]?\d+)?)$/i;
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
    // "self.made99" outside code is a password written so (memory-v5-3).
    if (!ends.test(rest) || (/^(?:this|self|super|cls)\./.test(member) && /\d/.test(member) && !codeish(line))) return false;
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
  if (op === ":" && !codeish(line)) return named && /^[A-Z][A-Za-z]*$/.test(id) && /^[a-z]/.test(key.name) && /^[ \t]+[a-z]/.test(line);
  return named || (!key.pin && id.length <= 3)
    || operator.test(after) || (op.startsWith("==") && !/\d/.test(id)) || (CODE_LINE.test(line) && codeLineName(id));
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
 * The bracket ("(", "[" or "{") opened on an earlier line that the line at `lineStart` stands inside, looked for in the
 * 2 KiB before it, or undefined: only a line of code opens one (`codeish`), so prose in brackets never does. A call's,
 * a signature's or an object's own lines read as code by it ("connect(\n    password=password\n)", "auth = {\n
 * password: urlPassword\n}"): memory-w5-1, memory-w5-2.
 */
function openedAbove(text: string, lineStart: number): string | undefined {
  let depth = 0;
  for (let i = lineStart - 1; i >= Math.max(0, lineStart - 2048); i--) {
    const c = text[i]!;
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) { depth--; continue; }
      // Its line, at most 200 characters either side of it, so a long line stays linear.
      const head = text.slice(Math.max(0, i - 200), i);
      const end = text.indexOf("\n", i);
      return codeish(head.slice(head.lastIndexOf("\n") + 1) + text.slice(i, Math.min(end < 0 ? text.length : end, i + 200))) ? c : undefined;
    }
  }
  return undefined;
}

/**
 * Whether a value that opens with a bracket is code ("[]", "{", "(await getToken())", "{ type: String }", "[token]",
 * "[str]", "<your-key>", an arrow's parameters, names or numbers in code: "[bos]", "(where, at) =>"), never a word
 * written in one after a label ("Netflix password: (fluffy)", "Wi-Fi password: [BlueSky]"): memory-v5-3.
 */
function codeInBracket(v: string, line: string, op: string): boolean {
  const first = /^\S+/.exec(v)![0].replace(/[,;]$/, "");
  if (BRACKET_HOLDER.test(first) || BRACKET_CAPS.test(first) || /^\([^()]*\)\s*(?::\s*[^=]{1,80})?=>/.test(v)) return true;
  const inner = /^[([{<]([^)\]}>\n]*)/.exec(v)![1]!.trim();
  if (!inner || /[.(){}[\]<>:=;"'`$*&|+]|\bfor\b.*\bin\b/.test(inner)) return true;
  const inCode = op !== ":" || codeish(line);
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
 * `text` with the name of each secret-named key whose ":" or "=" is followed by code written out as "_" (memory-r4-1,
 * memory-r4-2), so neither the redactor nor this guard reads that code as the secret's value. Its value is kept.
 */
function withoutCodeKeys(text: string): string {
  let out = "";
  let at = 0;
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
          || (/^[A-Z_][A-Z0-9_]*$/.test(name) && SHELL_CAPS_BEFORE.test(text.slice(lineStart, start)) && !/[([]/.test(openedAbove(text, lineStart) ?? ""))),
    };
    let code: boolean;
    // An arrow's parameter, a path, or a property about the secret ("token.type").
    if (op === "=>" || op === "::" || (property && !VALUE_PROPERTY.test(segs.at(-1)!))) code = true;
    else {
      // Each look is bounded (a value's first 400 characters, its line's first and last 200), so a long line of
      // keys stays linear.
      const lineEnd = text.indexOf("\n", i);
      const end = lineEnd < 0 ? text.length : lineEnd;
      const rest = text.slice(i, Math.min(end, i + 400)).replace(/^[ \t]+/, "");
      const line = end - lineStart <= 400 ? text.slice(lineStart, end) : `${text.slice(lineStart, lineStart + 200)}\n${text.slice(end - 200, end)}`;
      if (rest) code = readsAsCode(key, rest, line, op);
      else {
        // Nothing after it on its line: a block, a mapping, a comment or a statement follows, unless the next line is
        // its value ("Wi-Fi password:\nBlueSky99").
        const next = lineEnd < 0 ? undefined : /^[ \t]*\S[^\n]*/m.exec(text.slice(lineEnd + 1, lineEnd + 1 + 400))?.[0];
        // A mapping or a statement only indented under it, a comment's next line only in a comment, never prose on
        // the next line ("Admin password:\ndefault is admin123", "Wi-Fi password:\n* BlueSky99"): memory-v5-3.
        // A statement may follow at the same depth after a block's own line or a comment ("case X:\ncase Y:").
        const under = next !== undefined && /^[ \t]*/.exec(next)![0].length > /^[ \t]*/.exec(line)![0].length;
        const block = CODE_STATEMENT.test(line.trim()) || /^\s*(?:\/\/|\/\*|\*|#)/.test(line);
        code = next === undefined || (under && /^\s*[A-Za-z_$][\w$.-]*["']?\s*[:=]/.test(next)) || ((under || block) && codeStatement(next.trim()))
          || (/^\s*(?:\/\*|\*)/.test(line) && /^\s*\*(?:\s|$)/.test(next)) || readsAsCode(key, next.trim(), next, op);
      }
    }
    if (!code) continue;
    out += text.slice(at, start) + "_".repeat(name.length);
    at = start + name.length;
  }
  return at === 0 ? text : out + text.slice(at);
}

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
const TOLD_SECRET = new RegExp(
  String.raw`\b(?:pass(?:word|phrase|code|wd)|pw|pin|passcode|otp|2fa code|verification code|recovery (?:code|key|phrase|words)|puk|seed (?:phrase|words)|mnemonic|(?:bitcoin|btc|crypto|wallet|ethereum|eth|ledger|metamask) seed|unlock phrase|security (?:question )?answer|answer to (?:(?:my|the|a|your|our|their|his|her)\s+)?(?:[a-z]+['’]s\s+)?security question|cvv|cvc|wi-?fi (?:key|password)|network (?:security )?key|wpa[23]? (?:key|passphrase)|pre-?shared key|psk|api[ _-]?(?:key|token)|secret(?: access)?[ _-]?key)s?\b${FOR_WHAT}(?:\s+(?:everywhere|anywhere|here|there|now|too|also|always|usually|still|today|currently))?${SAYS_VALUE}${VALUE}`,
  "i",
);

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
const PIN_NUMBER = new RegExp(String.raw`\b(?:pin|passcode)\s+(?:code|number|no\.?)(?=[\s:=])${FOR_WHAT}${SAYS}["'“]?\d(?:[-\s]?\d){3,11}\b`, "i");
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
  String.raw`\b(?:(?:my|his|her|their)\s+(?:mobile|cell|cellphone|smartphone|phone|android)|android(?=\s+(?:unlock|lock|screen))|iphone|ipad|tablet|laptop|macbook|kindle)(?:['’]s)?\s+(?:(?:unlock|lock|screen|lock\s+screen|screen\s+lock)\s+)?(?:code|pin|passcode)s?\b${FOR_WHAT}${SAYS}["'“]?\d(?:[-\s]?\d){3,11}\b${NOT_DIGITS_OF_A_CODE}`,
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
 * ("@octocat"), a host with its port ("localhost:8080") and an environment variable in code ("process.env.AWS_CREDS_V2"):
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
  + String.raw`(?!(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}):\d{1,5}(?:[\s.,;!?)"'”]|$))(?!(?:process\.env|import\.meta\.env|os\.environ|env)[.[])`
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
 * "root = width / 2000"), but "Admin = admin / hunter2!" (memory-v5-4).
 */
const ADMIN_PAIR = new RegExp(
  String.raw`\b(?:admin|administrator|root)\b${FOR_WHAT}(?!\s*=)${SAYS}["'“]?(?![\d(+\-–—~.])[^\s/]+\s+/\s+["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`
  + String.raw`|(?<!\b(?:const|let|var|val|final|static|auto|int|float|double|local)\s+)\b(?:admin|administrator|root)\s*=(?![^\n;]{0,200};[ \t]*(?:\n|$))\s*["'“]?(?![\d(+\-–—~.])[^\s/()]+\s+/\s+`
  + String.raw`["'“]?(?![\d.]+(?:[\s,)]|$))(?![^\s"'”]*[()])(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
  "i",
);
/** "Wifi: BlueSky99": the network's key, only with a digit or a symbol in it ("Wifi: slow" is a fact). */
const WIFI_KEY = /\bwi-?fi\b\s*[:=]\s*["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{6,}/i;
/**
 * A seed phrase on its own ("seed: abandon ability able about above absent", "Seed: …"): six or more lowercase words, so
 * "Seed: Use The Fixtures First" is a heading (memory-1).
 */
const SEED_WORDS = /\b[Ss]eed\b\s*(?::|=|\bis\b)\s*(?:[a-z]+\s+){5,}[a-z]+/;
/**
 * "user priya, pass hunter2": "pass" as a password, but only after a user name or login, since it is a common word, and
 * with a digit or a symbol in its value unless a ":" or "=" says it is one ("so we pass our own object" is a verb), or as
 * the last word straight after "user" and a name ("username bob pass hunter", never "the user should pass validation"
 * or "make the user tests pass again": memory-v5-4).
 */
const PASS_NOT_USER = String.raw`should|must|can|could|will|would|may|might|shall|to|do|does|did|doesn['’]t|don['’]t|didn['’]t|can['’]t|won['’]t|cannot|needs?|has|have|had|is|was|are|and|or|then|also|always|never|who|that|which|gets?|got|input|data|tests?|checks?|requests?|sessions?|ids?|names?|accounts?|records?|objects?|info|details|credentials|creds|events?|flows?|stories|story`;
const PASS_NOT_VALUE = String.raw`again|now|through|on|by|it|them|this|that|the|a|an|all|fine|locally|validation|review|tests?|ci|checks?|over|along|away|out|up|down|in|back|around|here|there|first|too|also|today|anyway|either|though|yet|muster|ok|okay|safely|correctly|properly|cleanly|green|unchanged|null|none|true|false|undefined|args|arguments|params|parameters|data|values?|control|ownership|context|state|props|everything|anything|nothing|both|well|quickly|later|soon|instead`;
const LOGIN_PASS = new RegExp(String.raw`\b(?:user(?:name)?|login)\b[^\n]{0,60}?\bpass\b(?:\s*[:=]\s*["'“]?|\s+["'“]?(?=[^\s"'”,;]{0,64}[0-9!@#$%^&*]))[^\s"'”,;]{3,}`
  + String.raw`|\buser(?:name)?\s+["'“]?(?!(?:${PASS_NOT_USER})\b)[\w.@-]{2,}["'”]?,?\s+pass\s+["'“]?(?!(?:${PASS_NOT_VALUE})\b)[A-Za-z]{3,}["'”]?(?=\s*(?:$|\n|[.,;!?)]))`, "i");
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
  String.raw`\b(?:(?:${PLACES})(?:\s+(?:${LOCK_WORDS}))?\s+(?:code|combination|combo|pin)s?|key ?codes?|door ?codes?)\b${FOR_WHAT}(?:${SAYS}|\s+)["'“]?#?\d(?:[-\s]?\d){2,}(?![\d-]|\s*(?:errors?|status|responses?|forbidden|unauthori[sz]ed|http)\b)`,
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
  const said = withoutCodeKeys(text.replace(AUTH_REFERENCE, "_"));
  const probe = said.replace(NAMED_NO_VALUE, " ");
  if (redactSecrets(probe) !== probe) return "it holds a password, token or key";
  // The redactor hides a key only with its END line too: a key's first line alone is still a key's start (audit).
  if (PRIVATE_KEY_START.test(text)) return "it holds a private key";
  const pins = withoutPostcodes(said);
  if (TOLD_SECRET.test(said) || BARE_PASSWORD.test(said) || BARE_PIN.test(pins) || LOGIN_PASS.test(said) || PLACE_CODE.test(said)
    || CODE_FOR_PLACE.test(said) || BARE_CVV.test(said) || USED_AS.test(said) || LOGIN_PAIR.test(said) || WIFI_KEY.test(said) || SEED_WORDS.test(said)
    || PIN_NUMBER.test(pins) || DEVICE_CODE.test(said) || TOLD_TOKEN.test(said) || ADMIN_PAIR.test(said) || VALUE_FIRST.test(said)) {
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
