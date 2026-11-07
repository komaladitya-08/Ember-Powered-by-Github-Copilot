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
  "printed", "written", "listed", "attached", "included", "strict", "changing", "same",
].join("|");

/**
 * A secret's name with one of those words where its value would be ("Password: changed yesterday"): taken out before
 * the redactor looks, which would otherwise take "changed" for the password.
 */
const NAMED_NO_VALUE = new RegExp(
  String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*(?:=|:)\s*["']?(?:${NOT_A_VALUE})(?=[\s.,;!?"']|$)`,
  "gi",
);

/** A value where a secret's would be: anything but a word like "required" (NOT_A_VALUE), quoted or not. */
const VALUE = String.raw`["'“]?(?!(?:${NOT_A_VALUE})(?:[\s.,;!?"'”]|$))\S+`;
/**
 * What may stand between a secret's name and "is": a short phrase that says what it is for ("for the HR portal", "at
 * home", "to unlock it"), a preposition and one to four words. A hyphen inside a word ("e-mail") isn't a separator.
 */
const FOR_WHAT = String.raw`(?:\s+(?:for|to|at|on|of|in|into|with|from)(?:\s+[^\s:=]+){1,4}?)?`;
/** "is", "'s", "was", "are", "is:", or ":", "=", a spaced "-" or one before a digit ("PIN-4821"). */
const SAYS = String.raw`(?:\s*[:=]|\s*-(?=\s|\d)|['’]s\s|\s+(?:is|was|are|were)(?:\s*[:=])?\s)\s*`;

/**
 * "my password is…", "PIN: 1234", "the wifi key is…", "the password for the HR portal is…": a secret's name, perhaps
 * what it is for, then its value (not a word like "required").
 */
const TOLD_SECRET = new RegExp(
  String.raw`\b(?:pass(?:word|phrase|code|wd)|pw|pin|passcode|otp|2fa code|verification code|recovery (?:code|key|phrase|words)|seed (?:phrase|words)|mnemonic|(?:bitcoin|btc|crypto|wallet|ethereum|eth|ledger|metamask) seed|unlock phrase|security (?:question )?answer|answer to (?:my|the|a) security question|cvv|cvc|wi-?fi (?:key|password)|api[ _-]?(?:key|token)|secret(?: access)?[ _-]?key)s?\b${FOR_WHAT}${SAYS}${VALUE}`,
  "i",
);

/**
 * A password or passcode with its value straight after ("VPN password hunter2", "the password 'Summer2024!'"): only a
 * value with a digit or a symbol in it, so "password manager" and "password reset" are still words.
 */
const BARE_PASSWORD = new RegExp(
  String.raw`\b(?:pass(?:word|wd|code)|pwd)s?\s+["'“]?(?!(?:${NOT_A_VALUE})(?:[\s.,;!?"'”]|$))(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
  "i",
);
/** A PIN with four or more digits straight after ("the phone unlock PIN 1379", "PIN number 4821"). */
const BARE_PIN = /\bpin(?:\s+(?:code|number))?\s+\d{4,12}\b/i;
/** A card's security code with its digits straight after ("…with CVV 123", "CVC 4821"). */
const BARE_CVV = /\b(?:cvv2?|cvc2?|csc)\s*(?:code|number)?\s*[:#]?\s*\d{3,4}\b/i;
/** "Use hunter2 as the password for…": a value said before the secret's name ("…as the PIN pad app" names no PIN). */
const USED_AS = new RegExp(String.raw`\buse\s+["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))\S+["'”]?\s+as\s+(?:the|my|our|your|a)?\s*(?:pass(?:word|phrase|code)|pin|pw)s?(?=\s*$|[.,;!?]|\s+(?:for|on|at|to|of|in|with)\b)`, "i");
/**
 * A login with its user name and password together ("Login for the router: admin / P@ssw0rd", "credentials for staging
 * are admin and hunter22"): only when the second has a digit or a symbol, so "Login for the wiki is via SSO and Okta"
 * stays a fact.
 */
const LOGIN_PAIR = new RegExp(
  String.raw`\b(?:login|log-in|sign-in|credentials?|creds)\b${FOR_WHAT}${SAYS}["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))\S+\s*(?:/|,|\band\b|\bwith\b)\s*["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
  "i",
);
/** "Wifi: BlueSky99": the network's key, only with a digit or a symbol in it ("Wifi: slow" is a fact). */
const WIFI_KEY = /\bwi-?fi\b\s*[:=]\s*["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{6,}/i;
/** A seed phrase on its own ("seed: abandon ability able about above absent"): six or more lowercase words. */
const SEED_WORDS = /\bseed\b\s*(?::|=|\bis\b)\s*(?:[a-z]+\s+){5,}[a-z]+/;
/** "user priya, pass hunter2": "pass" as a password, but only after a user name or login, since it is a common word. */
const LOGIN_PASS = /\b(?:user(?:name)?|login)\b[^\n]{0,60}?\bpass\b(?:\s*[:=]\s*|\s+)["'“]?[^\s"'”,;]{3,}/i;
/**
 * A code or combination for a door, alarm, safe and the like, with digits for its value ("the door code is 4821",
 * "Garage code: 7734", "backup codes are 1234-5678", "the safe combination is 32-18-04"). "The door code changes on
 * Monday" and "the access code for the conference is on the invite" have no digits where the value would be.
 */
const PLACES = String.raw`door|front door|back door|gate|garage|alarm|safe|lock|bike lock|locker|entry|access|backup|one-time|recovery|unlock|security|building|keypad|key ?safe|lockbox|padlock|vault|house|flat|apartment|office`;
const PLACE_CODE = new RegExp(
  // "Garage opener code": one word may stand between the place and its code; "keycode" is one on its own.
  String.raw`\b(?:(?:${PLACES})(?:\s+[a-z]+)?\s+(?:code|combination|combo|pin)s?|key ?codes?|door ?codes?)\b${FOR_WHAT}(?:${SAYS}|\s+)["'“]?#?\d(?:[-\s]?\d){2,}`,
  "i",
);
/**
 * The code or combination first, then what it opens ("the code for the front door is 4821", "the combination to my bike
 * lock is 1234", "the code to the safe is 32-18-04"), with digits for its value. "The area code for London is 020" names
 * no place that locks, and "the code for the report is in GitHub" has no digits.
 */
const CODE_FOR_PLACE = new RegExp(
  String.raw`\b(?:code|combination|combo|pin|keycode)s?\s+(?:for|to|of|at|on)\s+(?:[^\s:=]+\s+){0,3}?(?:${PLACES})\b${SAYS}["'“]?#?\d(?:[-\s]?\d){2,}`,
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
  const probe = text.replace(NAMED_NO_VALUE, " ");
  if (redactSecrets(probe) !== probe) return "it holds a password, token or key";
  // The redactor hides a key only with its END line too: a key's first line alone is still a key's start (audit).
  if (PRIVATE_KEY_START.test(text)) return "it holds a private key";
  if (TOLD_SECRET.test(text) || BARE_PASSWORD.test(text) || BARE_PIN.test(text) || LOGIN_PASS.test(text) || PLACE_CODE.test(text)
    || CODE_FOR_PLACE.test(text) || BARE_CVV.test(text) || USED_AS.test(text) || LOGIN_PAIR.test(text) || WIFI_KEY.test(text) || SEED_WORDS.test(text)) {
    return "it holds a password, PIN or code";
  }
  for (const m of text.match(CARD) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) return "it holds a card number";
  }
  if (SSN.test(text) || (text.match(IBAN) ?? []).some(iban)) return "it holds an account or ID number";
  return null;
}
