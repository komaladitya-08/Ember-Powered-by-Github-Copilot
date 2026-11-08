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
 * what it is for, then its value (not a word like "required").
 */
const TOLD_SECRET = new RegExp(
  String.raw`\b(?:pass(?:word|phrase|code|wd)|pw|pin|passcode|otp|2fa code|verification code|recovery (?:code|key|phrase|words)|puk|seed (?:phrase|words)|mnemonic|(?:bitcoin|btc|crypto|wallet|ethereum|eth|ledger|metamask) seed|unlock phrase|security (?:question )?answer|answer to (?:my|the|a) security question|cvv|cvc|wi-?fi (?:key|password)|api[ _-]?(?:key|token)|secret(?: access)?[ _-]?key)s?\b${FOR_WHAT}(?:\s+(?:everywhere|anywhere|here|there|now|too|also|always|usually|still|today|currently))?${SAYS_VALUE}${VALUE}`,
  "i",
);

/**
 * A password or passcode with its value straight after ("VPN password hunter2", "the password 'Summer2024!'", "HR portal pw
 * Summer2024!"): only a value with a digit or a symbol in it, so "password manager", "password reset" and "£500 pw for
 * the flat" are still words.
 */
const BARE_PASSWORD = new RegExp(
  String.raw`\b(?:pass(?:word|wd|code)|pwd|pw|wi-?fi\s+key)s?\s+["'“]?(?!(?:${NOT_A_VALUE})(?:[\s.,;!?"'”]|$))(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
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
 * is 404ing") and how it is made ("the credentials are AES-256 encrypted", "the login is 2FA-protected") stay facts.
 */
const AUTH_SCHEME = String.raw`oauth|saml|fido|ntlm|ntlmv|kerberos|krb|ldaps?|openid|oidc|u2f|webauthn|totp|hotp|2fa|mfa|sso|pkce|tls|ssl|base|sha|md5|aes|rsa|hmac|utf|jwt|x509`;
const LOGIN_VALUE = String.raw`["'“]?(?!(?:${NOT_A_VALUE})(?:[\s"'”]|$))(?![^\s@"'”]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[\s.,;!?"'”]|$))`
  + String.raw`(?![a-z][a-z0-9+.-]*:\/\/|www\.)(?![$%{])(?!(?:${AUTH_SCHEME})\d*(?:[\s.,;!?"'”]|$))(?!(?:19|20)\d\d(?:[\s.,;!?"'”]|$))`
  + String.raw`(?!\d{1,4}(?:[-/:.]\d{1,4})+(?:am|pm)?(?:[\s.,;!?"'”]|$))(?!\d{1,2}(?::\d\d)?\s?(?:am|pm)\b)(?!\d+(?:ing|ed|s)\b)(?![^\s"'”]{1,11}-[a-z]{3,}(?:[\s.,;!?"'”]|$))`
  + String.raw`(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}["'”]?(?=\s*(?:$|\n)|[.,;!?)]|\s+[-–—]|\s+(?:and|but|so|for|on|at|to|in|with|from|which|if|or)\b)`;
const TOLD_LOGIN = new RegExp(
  String.raw`\b(?:(?:login|log-in|sign-in)\b${FOR_WHAT}\s+(?:is|was)\s+|(?:credentials?|creds)\b${FOR_WHAT}(?:\s*[:=]\s*|\s+(?:is|are|was|were)(?:\s*[:=])?\s+))${LOGIN_VALUE}`,
  "i",
);
/**
 * An admin's or root's user name and password ("Jenkins admin: admin / j3nkins!"): only with a spaced slash between and a
 * digit or a symbol in the second, so "root: /opt/app2" and "the admin is Priya, with Bob as backup" stay (memory-1).
 */
const ADMIN_PAIR = new RegExp(
  String.raw`\b(?:admin|administrator|root)\b${FOR_WHAT}${SAYS}["'“]?\S+\s+/\s+["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`,
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
 * Monday" and "the access code for the conference is on the invite" have no digits where the value would be. A house's,
 * a home's or an office's own code locks it ("my house code is 4821": memory-i4), only as someone's or "the" one ("the
 * office code is 4821"), never a post office's, a branch or head office's, a box office's or in-house source code
 * ("Post office code: 560001", "Our in-house code is 2000 lines long": memory-v4-3); with another word between ("our
 * office ZIP code is 90210", "the house style code 123") only a word for its lock counts (memory-r6).
 */
const OWN_PLACE = String.raw`(?:my|our|your|his|her|their|the|[a-z]+['’]s)\s+(?:house|home|office)`;
const PLACES = String.raw`door|front door|back door|gate|garage|alarm|safe|lock|bike lock|locker|entry|access|backup|one-time|recovery|unlock|security|building|keypad|key ?safe|key ?box|lockbox|padlock|vault|flat|apartment|${OWN_PLACE}`;
/** Places that only lock, so a code for one is a lock's whatever word comes before it ("the bank code for the vault"). */
const LOCKS = String.raw`door|front door|back door|side door|gate|garage|alarm|safe|bike lock|locker|keypad|key ?safe|key ?box|lockbox|padlock|vault`;
/**
 * What may stand between a place and its code: only a word for what opens it ("garage opener code", "building entry
 * code"), never any word, so "the access control code 401", "backup exit code 255" and "a security error code 403" stay
 * (memory-r6).
 */
const LOCK_WORDS = String.raw`door|front door|back door|side door|entry|entrance|alarm|keypad|lock|opener|remote|gate|access|unlock|security|key ?safe|lockbox|padlock`;
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
  const probe = text.replace(NAMED_NO_VALUE, " ");
  if (redactSecrets(probe) !== probe) return "it holds a password, token or key";
  // The redactor hides a key only with its END line too: a key's first line alone is still a key's start (audit).
  if (PRIVATE_KEY_START.test(text)) return "it holds a private key";
  const pins = withoutPostcodes(text);
  if (TOLD_SECRET.test(text) || BARE_PASSWORD.test(text) || BARE_PIN.test(pins) || LOGIN_PASS.test(text) || PLACE_CODE.test(text)
    || CODE_FOR_PLACE.test(text) || BARE_CVV.test(text) || USED_AS.test(text) || LOGIN_PAIR.test(text) || WIFI_KEY.test(text) || SEED_WORDS.test(text)
    || PIN_NUMBER.test(pins) || DEVICE_CODE.test(text) || TOLD_TOKEN.test(text) || ADMIN_PAIR.test(text) || VALUE_FIRST.test(text) || TOLD_LOGIN.test(text)) {
    return "it holds a password, PIN or code";
  }
  for (const m of text.match(CARD) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) return "it holds a card number";
  }
  if (SSN.test(text) || (text.match(IBAN) ?? []).some(iban)) return "it holds an account or ID number";
  return null;
}
