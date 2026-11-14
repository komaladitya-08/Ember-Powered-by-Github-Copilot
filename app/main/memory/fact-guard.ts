/**
 * What a remembered fact may not say beyond `memoryRefusal` (./guard.ts): a password, PIN or key said with a verb
 * instead of its name ("Signs in to Netflix with … and Winter#2024", "Unlocks their phone with 482913", "Uses hunter2
 * for Netflix", "Enters 4821 at the gate"), as a user and a value after a service's name ("Jira: ram / Winter#2024"),
 * as what a lock or a thing with a password "is" ("The front door is 4821", "The work VPN is Summer2024!"), or under a
 * name the guard lacked: an authenticator's secret or setup key, a private, encryption or client secret key, "my
 * secret is…", a memorable, secret or security word, pass, pswd, p/w and passkey, a card's three digits, and a US
 * account with its routing number (memory-r9-4). Memory's note promises it never keeps passwords, codes or card
 * numbers, however they are said, and memory outlives the conversation.
 *
 * Only facts pass here (`MemoryGraph.add`, a correction): never Projects' files or a task's view, which share
 * `memoryRefusal` and are full of code, where a verb with a value that holds a digit is ordinary. A fact is one short
 * sentence, so reading its verb is safe there. It only ever refuses more than `memoryRefusal`, never less; where a
 * word can't be told from a password ("Signs in with jsmith42") it is refused (fail closed). Pure.
 */

import { FOR_WHAT, LOGIN_VALUE, NOT_A_VALUE, NOW, PLACES, SAYS, STATE_ALGORITHM, memoryRefusal, secretShaped } from "./guard";

/** Where a value ends: the fact's or the clause's end, or a word that goes on ("…for Netflix", "…to sign in"). */
const END = String.raw`(?=["'”]?\s*(?:$|\n|[.,;!?)]|\s+[-–—]|\s+(?:and|but|so|for|on|at|to|in|with|from|which|if|or|when)\b))`;
/** Four to eight digits as a door, a phone or an alarm takes them ("4821", "482913", "4821#", "32-18-04"), where a value ends. */
const DIGITS = String.raw`#?\d(?:[-\s]?\d){3,7}[#*]?${END}`;
const WHOSE = String.raw`(?:the|my|our|your|their|his|her|a|an)`;
/** Verbs that say getting in, which take a password or a code after "with". */
const ACCESS = String.raw`(?:sign(?:s|ed|ing)?[\s-]+(?:in|on)(?:to)?|log(?:s|ged|ging)?[\s-]*(?:in|on)(?:to)?|unlock(?:s|ed|ing)?|disarm(?:s|ed|ing)?|authenticat(?:e|es|ed|ing)|(?:get(?:s|ting)?|got)\s+in(?:to)?)`;
/** What only a code opens (never a locker, whose number is which locker it is). */
const LOCKED = String.raw`(?:(?:front|back|side|garage|office|flat|house|main)\s+)?door|gate|garage|alarm|safe|keypad|key ?safe|key ?box|lockbox|padlock|vault|shed|bike lock`;
const DEVICES = String.raw`phone|iphone|ipad|tablet|laptop|macbook|computer|pc|mac`;
/** What takes a password and has no model name to be mistaken for one. */
const PASSWORDED = String.raw`vpn|wi-?fi|wlan|filevault|bitlocker|luks|veracrypt|keychain|bios|disk encryption`;
/** Services a person signs in to, where a word with a digit after "uses" or "for" is its password. */
const SERVICES = String.raw`netflix|spotify|hulu|disney\+?|amazon|prime\s+video|gmail|outlook|hotmail|yahoo|icloud|apple\s+id|paypal|venmo|ebay|steam|xbox|playstation|psn|nintendo|uber|airbnb|dropbox|facebook|instagram|twitter|linkedin|reddit|discord|github|gitlab|jira|slack|zoom|online\s+banking|bank`;

/** "Signs in to Netflix with ram@example.com and Winter#2024", "Unlocks their phone with 482913": the verb, then "with" and what gets in, perhaps after a user name. */
const VERB_WITH = new RegExp(String.raw`\b${ACCESS}\b[^.;!?\n]{0,80}?\b(?:with|using|via)\s+(?:(?:${WHOSE}\s+)?(?:user(?:name)?|login|account|e-?mail)\s+)?`
  + String.raw`(?:["'“]?[^\s,/"'”]{2,}["'”]?\s*(?:/|,|\band\b)\s*)?(?:(?:${WHOSE}\s+)?(?:password|passcode|passphrase|pin|code)\s+)?["'“]?(?:${DIGITS}|${LOGIN_VALUE})`, "i");
/** "Opens the garage with 4821": opening only with something that locks, and only digits. */
const OPENS_WITH = new RegExp(String.raw`\b(?:open(?:s|ed|ing)?|arm(?:s|ed|ing)?|lock(?:s|ed|ing)?)\s+(?:${WHOSE}\s+)?(?:[\w'’-]+\s+){0,2}?(?:${LOCKED}|${DEVICES}|office|building|house|flat|apartment|locker|storage unit|mailbox)\b`
  + String.raw`[^.;!?\n]{0,40}?\b(?:with|using)\s+(?:(?:${WHOSE}\s+)?(?:code|pin|combination|passcode)\s+)?${DIGITS}`, "i");
/** "Enters 4821 at the gate", "Types Summer2024! to unlock the laptop": the value first, then what it opens. */
const ENTERS = new RegExp(String.raw`\b(?:enter|type|key|punch|tap|input)(?:s|ed|ing)?(?:\s+in)?\s+["'“]?(?:#?\d(?:[-\s]?\d){3,7}[#*]?|(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,})["'”]?\s+`
  + String.raw`(?:(?:at|on|into|in)\s+(?:${WHOSE}\s+)?(?:[\w'’-]+\s+){0,2}?(?:${LOCKED}|${DEVICES}|office|building|locker)\b|to\s+(?:unlock|disarm|sign\s+in|log\s+in|get\s+in(?:to)?)\b)`, "i");
/** "Uses Winter#2024 to sign in to Jira", "Uses hunter2 for Netflix", "Uses admin / Summer2024! on the router" (`uses`). */
const USES = new RegExp(String.raw`\buses?\s+(?<user>["'“]?[A-Za-z][\w.@-]{1,40}["'”]?\s+/\s+)?["'“]?(?<value>${DIGITS}|${LOGIN_VALUE})\s+`
  + String.raw`(?:(?<to>(?:to|for)\s+(?:sign(?:ing)?[\s-]+(?:in|on)|log(?:ging)?[\s-]*(?:in|on)|unlock(?:ing)?|disarm(?:ing)?|get(?:ting)?\s+in(?:to)?|authenticat\w+)\b)`
  + String.raw`|(?:for|on|at)\s+(?:${WHOSE}\s+)?(?:[\w'’-]+\s+){0,2}?(?:(?<service>${SERVICES})|(?<thing>vpn|wi-?fi|router|login|sign-in|account|${DEVICES}|${LOCKED}))\b)`, "gi");
/** "Netflix uses hunter2". */
const SERVICE_USES = new RegExp(String.raw`\b(?:${SERVICES})\s+uses\s+["'“]?(?<value>${LOGIN_VALUE})`, "gi");
/**
 * "Jira: ram / Winter#2024", "Jira login ram / Winter#2024", "admin / Summer2024!": a user and a value where a clause
 * starts, after what they are for (`label`) or alone (`pair`).
 */
const PAIR = new RegExp(String.raw`(?:^|[.;!?\n]\s*)(?<label>[A-Z][\w'’&.+-]*(?:\s+[\w'’&.+-]+){0,3}?\s*(?::|\s(?:login|log-in|sign-in|account|credentials?)\b\s*:?)\s*)?`
  + String.raw`["'“]?[A-Za-z][\w.@-]{1,40}["'”]?\s+/\s+["'“]?(?<value>${LOGIN_VALUE})`, "g");
/** What says four digits are a time, a year or a size ("The alarm is 0630 on weekdays", "The garage is 2019 and newer"): memory-x9-8. */
const NOT_CODE_TAIL = String.raw`\s+(?:on\s+(?:weekdays|weekends|work\s?days|school\s+days|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)|every|each|daily|am|pm|(?:and|or)\s+(?:newer|later|older|earlier)|onwards)\b`;
/** "The front door is 4821", "Front door: 4821", "The alarm is 4821"; and the lock with its digits alone ("Front door 4821"). */
const LOCK_IS = new RegExp(String.raw`\b(?:${LOCKED})\b(?:\s+(?:is|was)\s+|\s*:\s*)${NOW}${DIGITS}(?!${NOT_CODE_TAIL})`, "i");
const LOCK_BARE = new RegExp(String.raw`^\s*(?:${WHOSE}\s+)?(?:${LOCKED})\s+#?\d{4,8}[#*]?\s*[.!]?\s*$`, "i");
/** "The gym's code is 4821": a place's own code. */
const PLACE_S_CODE = new RegExp(String.raw`\b(?:${PLACES})['’]s\s+(?:(?:door|entry|gate|alarm|access|unlock|security|lock)\s+)?(?:code|combination|combo|pin|passcode)\b${FOR_WHAT}${SAYS}${NOW}${DIGITS}`, "i");
/** "The code is 4821", "My code is 4821", "The combination is 32-18-04", "My phone unlock pattern is 1-4-7-8-9": never "the area code", nor "4821 lines long". */
const THE_CODE = new RegExp(String.raw`\b(?:(?:the|my|our|his|her|their)\s+(?:code|combination|combo)|(?:unlock|lock|screen)\s+pattern)\s+(?:is|was)\s+${NOW}${DIGITS}`, "i");
/** "The work VPN is Summer2024!", "FileVault: Summer2024!", "BitLocker is 482913-482913", "Work laptop: Summer2024!" (`thingIs`). */
const THING_IS = new RegExp(String.raw`\b(?:(?<soft>${PASSWORDED})|(?<hard>${DEVICES}|router|nas))\b(?:\s+(?:is|was)\s+|\s*:\s*)${NOW}["'“]?(?<value>\d{6}(?:-\d{6})+|${LOGIN_VALUE})`, "gi");
/** "My Wi-Fi is HomeNet and the key is BlueSky99": the key later in the Wi-Fi's own sentence. */
const WIFI_THEN_KEY = /\bwi-?fi\b[^.;!?\n]{0,80}?\b(?:key|pass|passphrase)\s+(?:is|was)\s+["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{6,}/i;

/** An authenticator's secret, seed or setup key ("My authenticator secret is JBSWY3DPEHPK3PXP", "2FA setup key: JBSW Y3DP…"). */
const OTP_SECRET = new RegExp(String.raw`\b(?:(?:authenticator|2fa|mfa|totp|hotp|otp|two-factor|two-step)\s+(?:app\s+)?(?:secret(?:\s+key)?|seed|key|setup\s+key)|setup\s+key)s?\b${FOR_WHAT}(?:(?<says>${SAYS})${NOW}|\s+)["'“]?(?<value>[^\s"'”]+)`, "gi");
/** A key or a secret that is a value, never a word, a path or an algorithm ("The private key is 5KJ…", "Client secret 8Q~… for the Azure app"). */
const KEY_SAID = new RegExp(String.raw`\b(?:(?:private|encryption|decryption|signing|secret(?:\s+access)?|master)\s+key|(?:client|shared|app|consumer|webhook|signing)\s+secret)s?\b${FOR_WHAT}(?:(?<says>${SAYS})${NOW}|\s+)["'“]?(?<value>[^\s"'”]+)`, "gi");
/** A name with a hyphened number or letter ("Vitamin-D3", "Zone1-3"), where a secret or a pass names what it is (memory-x9-8). */
const HYPHEN_NAME = String.raw`[A-Z][a-z]+(?:-[A-Z]\d{1,2}|\d-\d{1,2})["'”]?(?:[\s.,;!?]|$)`;
/** "My secret is hunter2", "The secret is Tr0ub4dor&3": never "the secret is patience". */
const A_SECRET = new RegExp(String.raw`\b(?:my|our|the|his|her|their)\s+secret\s+(?:is|was)\s+${NOW}["'“]?(?!${HYPHEN_NAME})${LOGIN_VALUE}`, "i");
/**
 * A bank's memorable word or information, a secret or security word, a secret answer: any word after it but one that says
 * no value. A memorable place, name or date only after a bank's or a security word, never "Favourite memorable place"
 * (memory-x9-8).
 */
const SECRET_WORD = new RegExp(String.raw`\b(?:memorable\s+(?:word|phrase|information|info|answer)|(?<=\b(?:bank|banking|security|account|sign[- ]?in|log[- ]?in)\b.*)memorable\s+(?:place|name|date)|(?:secret|security)\s+(?:word|phrase)|secret\s+answer|telephone\s+(?:banking\s+)?(?:password|passcode|code))s?\b`
  + String.raw`${FOR_WHAT}${SAYS}${NOW}["'“]?(?!(?:${NOT_A_VALUE}|asked|used|what|something|one)(?:[\s.,;!?"'”]|$))\S+`, "i");
/** "pswd: hunter2", "p/w hunter2", "My passkey is hunter2"; "pass: hunter2" and "the pass is hunter2", never a bus pass or tests that pass. */
const SHORT_PASS = new RegExp(String.raw`(?:\b(?:pswd|passkey)\b|(?<![\w/])p\/w(?![\w/]))${FOR_WHAT}(?:${SAYS}|\s+)["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`, "i");
const THE_PASS = new RegExp(String.raw`(?:^\s*pass\s*[:=]\s*|\b(?:the|my|our|his|her|their)\s+pass\s+(?:is|was)\s+)["'“]?(?!${HYPHEN_NAME})(?=[^\s"'”]*[A-Za-z])(?=[^\s"'”]*\d)${LOGIN_VALUE}`, "i");
/** A card's security digits said in words ("The card's three digits are 123", "Card security number 123"). */
const CARD_DIGITS = /\b(?:card(?:['’]s)?\s+(?:security|verification)\s+(?:number|code|digits?)|card['’]s\s+(?:three|3|four|4|security)\s+digits|(?:three|3|four|4)\s+digits\s+on\s+the\s+(?:back|front)(?:\s+of\s+(?:the|my|his|her|their)\s+card)?|security\s+(?:number|code)\s+on\s+the\s+(?:back|card))\b[^\d\n]{0,20}\d{3,4}(?!\d)/i;
/** A card the digits are on, so "the three digits on the back of the shirt" are kept (memory-x9-8). */
const CARD_WORD = /\b(?:card|cards|amex|visa|mastercard|debit|credit)\b|\bcard['’]s\b|^\s*(?:the\s+)?(?:three|3|four|4)\s+digits\s+on\s+the\s+(?:back|front)\s+(?:are|is|:)/i;
/** A US account with its routing number, either first. */
const US_ACCOUNT = String.raw`\baccount(?:\s+(?:number|no\.?))?\b[^\d\n]{0,20}\d{6,17}(?!\d)`;
const US_ROUTING = String.raw`\brouting(?:\s+(?:number|no\.?))?\b[^\d\n]{0,20}\d{9}(?!\d)`;
const US_BANK = new RegExp(String.raw`${US_ACCOUNT}[^\n]{0,60}?${US_ROUTING}|${US_ROUTING}[^\n]{0,60}?${US_ACCOUNT}`, "i");

const NO_VALUE = new RegExp(String.raw`^(?:${NOT_A_VALUE})$`, "i");
const ALGORITHM = new RegExp(String.raw`^(?:${STATE_ALGORITHM})`, "i");
/** A product's name with its version ("Windows11", "Office365", "iPhone15", "Canon5D", "3DSecure2"), and 1Password: a tool's name, never its password. */
const PRODUCT = /^(?:[a-z]?[A-Z][A-Za-z]*\d{1,3}[A-Z]?|\d[A-Z][A-Za-z]*\d{0,3}|1[Pp]assword)$/;
/** A speed, a size or a count ("300Mbps", "5GHz", "256GB"). */
const AMOUNT = /^\d+(?:\.\d+)?[A-Za-z%]{0,5}$/;
/** A value without its quotes or the full stop after it; a "!" stays, which ends a password more often than a fact. */
const bare = (v: string) => v.replace(/^["'“]+|["'”.,;?)]+$/g, "");
/** A value that can only be a password: it holds a symbol, or letters and digits as one is shaped (`secretShaped`). */
const strict = (v: string) => /[!@#$%^&*]/.test(v) || secretShaped(v);

/**
 * "Uses … to sign in", "Uses … for Netflix", "Uses … on the router": by what follows the value (USES). To sign in, any
 * such value; for a service, one shaped like a password; for a thing (a VPN, a laptop, an account), only one with a
 * symbol or one said with its user ("admin / hunter22"), since "Uses Python3 on the laptop" names a tool.
 */
function uses(text: string): boolean {
  for (const m of text.matchAll(USES)) {
    const v = bare(m.groups!.value!);
    if (m.groups!.to || /^#?[\d\s-]+[#*]?$/.test(v)) return true;
    if (m.groups!.service ? strict(v) && !PRODUCT.test(v) : /[!@#$%^&*]/.test(v) || (!!m.groups!.user && secretShaped(v) && !PRODUCT.test(v))) return true;
  }
  for (const m of text.matchAll(SERVICE_USES)) { const v = bare(m.groups!.value!); if (strict(v) && !PRODUCT.test(v)) return true; }
  return false;
}

/**
 * A user and a value shaped like a password (PAIR): after a label any such value but a tool's name with its version
 * ("Stack: React / Node20"), alone only one with a symbol ("PyTorch / Caffe2" is two tools). Never a standard's or a
 * mode's name ("Wi-Fi: HomeNet / WPA2-PSK").
 */
function pair(text: string): boolean {
  for (const m of text.matchAll(PAIR)) {
    const v = bare(m.groups!.value!);
    if (/^[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+$/.test(v)) continue;
    if (/[!@#$%^&*]/.test(v) || (!!m.groups!.label && secretShaped(v) && !PRODUCT.test(v))) return true;
  }
  return false;
}

/** A product named for what it is ("The VPN is NordVPN2"), never a Wi-Fi's "BlueSky99" (memory-x9-8). */
const namesItself = (v: string, thing: string) => v.toLowerCase().includes(thing.toLowerCase().replace(/[\s-]/g, ""));

/** What takes a password said as it (THING_IS): a device only with a symbol in the value, since "iPhone15" is its model. */
function thingIs(text: string): boolean {
  for (const m of text.matchAll(THING_IS)) {
    const v = bare(m.groups!.value!);
    if (/^\d{6}(?:-\d{6})+$/.test(v) || /[!@#$%^&*]/.test(v) || (m.groups!.soft && secretShaped(v) && !AMOUNT.test(v) && !(PRODUCT.test(v) && namesItself(v, m.groups!.soft)))) return true;
  }
  return false;
}

/** An authenticator's secret (OTP_SECRET) or a key (KEY_SAID) with a value that can be one. */
function keySaid(text: string): boolean {
  for (const m of text.matchAll(OTP_SECRET)) {
    const v = bare(m.groups!.value!);
    // With no "is" or colon ("TOTP seed JBSWY3DPEHPK3PXP") only a whole secret's length.
    if (!NO_VALUE.test(v) && /[A-Z0-9]{4}/.test(v) && (m.groups!.says || /^[A-Z0-9]{12,}$/.test(v))) return true;
  }
  for (const m of text.matchAll(KEY_SAID)) {
    const v = bare(m.groups!.value!);
    // A path, an address, an algorithm or how it is made ("~/.ssh/id_ed25519", "RSA-4096", "256-bit") is no key.
    if (NO_VALUE.test(v) || /^(?:~|\.{0,2}\/|[A-Za-z]:\\)|:\/\//.test(v) || ALGORITHM.test(v) || /^[^\s]{1,11}-[a-z]{3,}$/.test(v)) continue;
    if (v.length >= (m.groups!.says ? 8 : 16) && /[0-9~!@#$%^&*+/=]/.test(v)) return true;
  }
  return false;
}

// ───── A credential by its value (memory-r11-1, memory-c11-1) ─────
//
// The rules above read a password by the shape of its sentence, and each round found a shape they missed ("My AWS
// secret is …", "Gmail: ram99 / sunshine", "API key 9b2f…" with no "is"). What a credential is doesn't depend on its
// sentence: these read the value. A value shaped like a key or a token is refused wherever it stands; a value shaped
// like a password is refused in a clause that names a thing people sign in to; and a lone word is refused where a
// credential's name or a sign-in thing's stands right before it, whatever the words between. Fail closed: a word that
// may be the password costs the fact.

/** Things people sign in to: a service, what takes a password, a server's or a directory's name, a password manager. */
const SIGN_IN_THING = String.raw`(?:${SERVICES}|${PASSWORDED}|router|nas|aws|azure|gcp|radius|ldap|active\s+directory|ssh|sftp|ftp|smtp|imap|database|mysql|postgres(?:ql)?|admin|bitwarden|1password|lastpass|keepass(?:xc)?|dashlane|nordpass|okta|jenkins)`;
const THING_WORD = new RegExp(String.raw`(?:^|[^\w-])${SIGN_IN_THING}(?![\w-])`, "i");
/** Where people give their public handle, and a handle's shape there (lower case: "octocat2", "ram-k"). */
const HANDLE_PLACE = /\b(?:github|gitlab|twitter|instagram|reddit|discord|linkedin|facebook|steam|xbox|psn|playstation)\b/i;
const HANDLE = /^[a-z][a-z0-9_.-]{1,38}$/;
/**
 * A credential's own name, which a lone word after it is the value of. A login's or a sign-in's lone word may be the
 * user's name ("The GitHub login is octocat", which `memoryRefusal` reads by its shape: safety-privacy-v4-1), so it
 * counts only after a service that signs in by e-mail ("The login for Netflix is sunshine").
 */
const CRED_NOUN = String.raw`(?:secrets?|passwords?|passcodes?|passphrases?|passwd|pwd|pw|pins?|keys?|tokens?|logins?|log-ins?|sign-ins?)`;
/** A login's lone word that is a user's name by convention ("The router login is admin"). */
const USER_WORD = /^(?:admin|administrator|root|user|guest|pi|ubuntu|ec2-user)$/i;
/** What a key or a token is called, beside which a value shaped like one is the key (memory-c11-1). */
const KEY_NOUN = /^(?:keys?|apikeys?|tokens?|secrets?|cookies?|credentials?|creds|bearer|api|auth|authorization|session|sessions|pat|password|passwords|hook|webhook|hooks)$/i;
/**
 * Words a lone word after a credential's name may be without being its value: what says none, a state ("rotated",
 * "configured", "expired"), a plan ("premium", "family"), where it is kept. Anything else is the value.
 */
const NOT_LONE = new Set(String.raw`configured rotated revoked enabled disabled active inactive generated issued provisioned unset blank empty
  elsewhere somewhere nowhere fine slow down up broken off on paused cancelled canceled premium family basic standard free paid trial
  shared monthly yearly annual weekly yes no new old annoying long short simple hard easy secure insecure fun boring great useless
  expensive cheap again done gone lost known unknown everywhere anywhere there here same different`.split(/\s+/).filter(Boolean));
/** Who keeps a family's or a trade's secret, which is never a password ("Our family secret is cinnamon"). */
const STORY_SECRET = /^(?:family|trade|top|open|little|big|best-kept|biggest|deepest|darkest|dark|dirty|guilty|only|real|recipe|kitchen|grandma['’]?s?|nan['’]?s?|mum['’]?s?|dad['’]?s?|success|happiness)$/i;
/** How someone signs in that is no password ("Signs in with passkeys", "Logs in with fingerprint"). */
const SIGN_IN_WAY = /^(?:sso|saml|oauth|oidc|passkeys?|fingerprints?|face|touch|biometrics?|google|apple|microsoft|github|okta|yubikey|yubikeys|keys|cards?|badges?|phone|passwords?|pins?|codes?|email|e-mail|ease|difficulty|trouble|problems?)$/i;

/** A name with a hyphened number or letter, as a whole word ("Vitamin-D3"). */
const HYPHENED = new RegExp(String.raw`^${HYPHEN_NAME}`);
/** A way of signing in or a standard with its version ("OAuth2", "WPA3"), never a password. */
const AUTH_WORD = /^(?:oauth|saml|fido|ntlm|kerberos|ldaps?|openid|oidc|u2f|webauthn|totp|hotp|2fa|mfa|sso|tls|ssl|wpa|wep|jwt|x509)\d*$/i;
/** A value without the quotes, brackets and stops around it. */
const word = (raw: string) => raw.replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, "");

/** A word that can only be a key or a token: a UUID, a long run of hex, or a long run of letters and digits (`alone`: without a key's name beside it). */
function keyShaped(raw: string, alone: boolean): boolean {
  const v = word(raw);
  if (/:\/\/|^[~./\\]|^[\w.+-]+@[\w-]+\.|^[@#$£€]/.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  const hex = v.replace(/-/g, "");
  if (/^[0-9a-f]+$/i.test(hex) && /\d/.test(hex) && /[a-f]/i.test(hex) && hex.length >= (alone ? 24 : 16)) return true;
  // A JSON web token, which can be nothing else ("eyJhbGciOi….eyJzdWIi….sig"), with or without a key's name (r11-memory-x11-3).
  if (/^eyJ[\w-]{8,}\.[\w-]{4,}\.[\w-]*$/.test(v)) return true;
  if (!/^[A-Za-z0-9_\-+/=.~]+$/.test(v) || v.length < 16) return false;
  // One run of letters and digits as long as a key's ("a8f7d6s5a4d3f2g1h0j9k8l7"), never words joined ("bert-base-uncased").
  return v.split(/[-_.+/=~]+/).some(run => (run.length >= (alone ? 20 : 12)
    && (run.match(/\d/g)?.length ?? 0) >= (alone ? 4 : 2) && (run.match(/[A-Za-z]/g)?.length ?? 0) >= (alone ? 4 : 2))
    // Beside a key's name, a run of 16 or more in mixed case is one whatever its digits ("API key AbCdEfGhIjKl…":
    // r11-memory-x11-3), unless it is words joined in camel case ("HashiCorpVaultCluster", "JSESSIONIDCookie").
    || (!alone && run.length >= 16 && /^[A-Za-z0-9]+$/.test(run) && (run.match(/[A-Z]/g)?.length ?? 0) >= 3 && (run.match(/[a-z]/g)?.length ?? 0) >= 3
      && !/^(?:[a-z]{2,})?(?:[A-Z]+[a-z]{2,}|[A-Z]{2,}\d*)+$/.test(run)));
}

/** A word shaped like a password (`strict`), never a product's name, an amount, a standard, a handle or a user at a host. */
function passwordShaped(raw: string): boolean {
  const v = word(raw);
  // A user at a computer named by words ("admin@localhost", "jsmith@corp"), never "p4ss@word", which has a digit.
  if (/^[@#-]|[$(){}`<>|\\=]/.test(v) || AT_HOST.test(v) || /^[A-Za-z_][A-Za-z_.-]*@[A-Za-z][A-Za-z-]*$/.test(v) || PRODUCT.test(v) || AMOUNT.test(v)) return false;
  if (/^[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+$/.test(v) || /^[^\s]{1,11}-[a-z]{3,}$/.test(v) || ALGORITHM.test(v) || HYPHENED.test(v)) return false;
  if (AUTH_WORD.test(v)) return false;
  return strict(v);
}

/** A lone word: ends its clause, or goes on with a word that says what it is for ("…for Netflix", "…on the VPN"). */
const LONE = String.raw`["'“]?(?<v>[^\s"'”,;!?/]{2,40}?)["'”]?(?=\s*(?:$|\n|[.,;!?)](?:\s|$)|\s+(?:for|on|at|to|in|with|from|and|but)\b))`;
/** "My AWS secret is …", "Our Jenkins secret: …", "The login for Netflix is …": a credential's name after what it is for, then a lone word. */
const NAMED_LONE = new RegExp(String.raw`(?:^|[^\w'’-])(?<q>(?:[\w'’.+-]+\s+){0,3})(?<noun>${CRED_NOUN})(?:\s+(?:for|to|of|on)\s+(?:${WHOSE}\s+)?[\w'’.+-]+(?:\s+[\w'’.+-]+)?)?\s*(?:\s(?:is|was|are|were)\s|['’]s\s|[:=]|\s[-–—]\s)\s*${NOW}${LONE}`, "gi");
/** "Netflix: sunshine", "Spotify — Bluebird77": a sign-in thing alone, then a lone word ("My Bitwarden is …" only by its shape, above). */
const THING_LONE = new RegExp(String.raw`^\s*(?:${WHOSE}\s+)?(?:[\w'’-]+\s+)?${SIGN_IN_THING}(?:\s+(?:account|login|sign-in|pass))?(?:\s+(?:at|for|in|on|of)\s+(?:${WHOSE}\s+)?[\w'’-]+(?:\s+[\w'’-]+)?)?\s*(?:[:=]|\s[-–—]\s|[-–—]\s)\s*${LONE}\s*$`, "i");
/** "Gmail: ram99 / sunshine", "My Gmail login is ram99 / sunshine": a sign-in thing, a user, then any value. */
const THING_PAIR = new RegExp(String.raw`${SIGN_IN_THING}(?:\s+(?:account|login|log-in|sign-in|credentials?))?\s*(?:[:=]|\s(?:is|was)\s|\s(?=[\w.@-]+\s*/))\s*["'“]?[A-Za-z][\w.@-]{1,40}["'”]?\s*(?:/|,|\band\b|&)\s*["'“]?(?<v>[^\s"'”.,;:!?]{2,40})(?=["'”]?(?:\s|$|[.,;!?](?:\s|$)))`, "gi");
/** "Netflix password. sunshine": a credential's name ending its sentence, and a lone word as the next. */
const NAME_THEN_WORD = new RegExp(String.raw`\b${CRED_NOUN}\s*[.:!?]\s+["'“]?(?<v>[^\s"'”.,;:!?]{2,40})["'”]?\s*[.!]?\s*$`, "i");
/** "I log into Netflix with sunshine": a verb of signing in, then "with" and a lone word in lower case. */
const ACCESS_WITH_WORD = new RegExp(String.raw`\b${ACCESS}\b[^.;!?\n]{0,80}?\b(?:with|using)\s+["'“]?(?<v>[a-z][a-z'’-]{2,})["'”]?\s*[.!]?\s*$`, "i");
/** "Netflix uses sunshine": a service that "uses" a lone word in lower case. */
const SERVICE_USES_WORD = new RegExp(String.raw`\b(?:${SERVICES}|${PASSWORDED})\s+uses\s+["'“]?(?<v>[a-z][a-z'’-]{2,})["'”]?\s*[.!]?\s*$`, "i");
/** "I always use my birthday 0412 for everything", "Remember 0412 everywhere": digits used for everything, never a count of something. */
const DIGITS_EVERYWHERE = /(?<![\w.£$€])#?\d{4,8}(?![\w.])(?!\s+(?:miles?|km|steps|people|times|users?|[a-z]+s)\b)[^.;!?\n]{0,20}?(?:\bfor\s+(?:everything|all\b|every\b)|\beverywhere\b)/i;

/**
 * The states a lone word after a credential's own name may say without being its value ("The client secret is
 * configured", "Forgot the password. Again"). Named one by one (r11-memory-x11-2): any other word there is the value,
 * whatever its ending ("blessed", "butterfly") or whether it is a plan's word ("My AWS secret is premium").
 */
const NAMED_STATE = new Set(String.raw`configured rotated revoked enabled disabled active inactive generated issued provisioned unset blank empty
  expired expiring changed reset stored saved hidden encrypted masked hashed lost gone done again out safe elsewhere somewhere nowhere
  here there it this that mine yours ours theirs same different because`.split(/\s+/).filter(Boolean));

/**
 * Whether a lone word may be a credential's value: after a credential's own name (`name`) unless a state it names
 * (NAMED_STATE); after a sign-in thing (`thing`, "Netflix: premium") unless talk about it (ABOUT_SECRET, NOT_LONE, a
 * tool's name); after a sign-in thing and a user (`pair`, "Gmail: ram99 / …") whatever the word but grammar.
 */
function loneValue(v: string, after: "name" | "thing" | "pair"): boolean {
  const raw = word(v), w = raw.toLowerCase();
  if (!w || sayless(w)) return false;
  if (after === "name" && NAMED_STATE.has(w)) return false;
  // After a user, only grammar goes on the sentence ("My SSH login is pi@host, why does…").
  if (after === "pair" && /^(?:why|what|when|where|how|who|which|and|or|but|so|then|the|a|an|it|is|are|was|were|i|you|we|they|he|she|my|your|our|their|his|her|its|this|that|please|thanks)$/.test(w)) return false;
  if (after === "thing" && (ABOUT_SECRET.has(w) || NOT_LONE.has(w) || TOOL_NAME.test(w) || /^(?:that|because)$/.test(w))) return false;
  // An issue, a handle, a user at a host, a standard ("WPA2-PSK") or a name with a hyphened number ("Vitamin-D3").
  return !/^[#@]/.test(raw) && !AT_HOST.test(raw) && !/^[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+$/.test(raw) && !HYPHENED.test(raw);
}

/**
 * Whether `text` holds a credential's value however it is said (memory-r11-1, memory-c11-1): a key or a token by its
 * shape (beside a key's name, or alone when it can be nothing else); a password's shape in a clause about a sign-in
 * thing; a lone word after a credential's or a sign-in thing's name, in any position; a user and any value after a
 * sign-in thing.
 */
function credentialValue(text: string): "key" | "password" | null {
  for (const clause of text.split(/[.;!?\n]+(?:\s|$)/)) {
    const words = clause.split(/\s+/).filter(Boolean);
    const keyName = words.some(w => KEY_NOUN.test(word(w)));
    if (words.some(w => keyShaped(w, !keyName))) return "key";
    // A handle where people name theirs ("GitHub: octocat2") is no password; a word shaped like one anywhere else is.
    if (THING_WORD.test(clause) && words.some((w, i) => passwordShaped(w) && !(HANDLE_PLACE.test(clause) && HANDLE.test(word(w)) && i > 0))) return "password";
  }
  for (const m of text.matchAll(NAMED_LONE)) {
    const q = (m.groups!.q ?? "").trim().split(/\s+/).filter(Boolean).filter(w => !new RegExp(String.raw`^${WHOSE}$`, "i").test(w));
    const noun = m.groups!.noun!.toLowerCase();
    const v = m.groups!.v!;
    if (!loneValue(v, "name")) continue;
    if (/^(?:logins?|log-ins?|sign-ins?)$/.test(noun)) {
      if (THING_WORD.test(m[0]) && !HANDLE_PLACE.test(m[0]) && !USER_WORD.test(word(v)) && !/@|:\d|^v?\d/.test(v)) return "password";
      continue;
    }
    // "The secret is patience": a secret with no thing before it is a password only by its shape.
    if (/^secrets?$/.test(noun) && (!q.length || q.some(w => STORY_SECRET.test(w)))) { if (passwordShaped(v)) return "password"; continue; }
    // A key alone is a door's ("The key is under the mat"): only after what it opens in software, and a token's value by its shape.
    if (/^(?:keys?|tokens?)$/.test(noun) && !(q.length && THING_WORD.test(q.join(" ")))) continue;
    return "password";
  }
  const lone = THING_LONE.exec(text)?.groups?.v;
  // A product named for what it is ("VPN: NordVPN2") is no password; any other product-like word there may be one.
  if (lone && loneValue(lone, "thing") && !(HANDLE_PLACE.test(text) && HANDLE.test(word(lone))) && !(PRODUCT.test(word(lone)) && /vpn|wi-?fi|router|nas/i.test(text) && /vpn|wifi|router|nas/i.test(lone)) && !AMOUNT.test(word(lone)) && !/^[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+$|-[a-z]{3,}$/.test(word(lone))) return "password";
  for (const m of text.matchAll(THING_PAIR)) {
    const v = word(m.groups!.v!);
    // A standard, a speed or a band beside a network's name ("Wi-Fi: HomeNet / 5GHz", "…, 802.11ac") is no password.
    if (!loneValue(v, "pair") || AMOUNT.test(v) || /^[\d.]+[a-z]*$/i.test(v) || AUTH_WORD.test(v)) continue;
    return "password";
  }
  const after = NAME_THEN_WORD.exec(text);
  if (after && loneValue(after.groups!.v!, "name")) return "password";
  for (const re of [ACCESS_WITH_WORD, SERVICE_USES_WORD]) {
    const m = re.exec(text);
    // In lower case only: a capitalised word there is a product's or a browser's name ("…using Chrome").
    if (m && /^["'“]?[a-z]/.test(m.groups!.v!) && loneValue(m.groups!.v!, "thing") && !SIGN_IN_WAY.test(m.groups!.v!)) return "password";
  }
  return DIGITS_EVERYWHERE.test(text) ? "password" : null;
}

/** An NHS, CHI, Medicare or social insurance number said with its name (PLAN §10 round 10, "left"). */
const HEALTH_ID = /\b(?:nhs|chi|medicare|health\s+(?:and\s+care\s+)?|social\s+insurance|sin)\s+(?:number|no\.?|#)\s*(?:(?:is|was)\s+|[:=]\s*)?\d{3}[\s-]?\d{3}[\s-]?\d{3,4}(?:[\s-]?\d)?\b/i;

/**
 * Why a fact may not be kept for what it says with a verb or under one of these names, in a few words for the model
 * to pass on, or null. Read only after `memoryRefusal` found nothing (`factRefusal`).
 */
export function saidSecret(text: string): string | null {
  if (VERB_WITH.test(text) || OPENS_WITH.test(text) || ENTERS.test(text) || uses(text) || pair(text) || LOCK_IS.test(text) || LOCK_BARE.test(text)
    || PLACE_S_CODE.test(text) || THE_CODE.test(text) || thingIs(text) || WIFI_THEN_KEY.test(text) || A_SECRET.test(text) || SECRET_WORD.test(text)
    || SHORT_PASS.test(text) || THE_PASS.test(text) || symbolValue(text) || codeBeside(text) || adminValue(text) || NETWORK_KEY.test(text)
    || SECURITY_QUESTION.test(text) || inWordOrder(text)) return "it holds a password, PIN or code";
  if (keySaid(text)) return "it holds a password, token or key";
  const credential = credentialValue(text);
  if (credential) return credential === "key" ? "it holds a password, token or key" : "it holds a password, PIN or code";
  if (HEALTH_ID.test(text)) return "it holds an account or ID number";
  if (CARD_DIGITS.test(text) && CARD_WORD.test(text)) return "it holds a card's security code";
  if (US_BANK.test(text) || ID_DOCUMENT.test(text)) return "it holds an account or ID number";
  return null;
}

/** A user at a host with a dot, a dash or a port ("deploy@build-01", "root@127.0.0.1:2222"): an address, never a password. */
const AT_HOST = /^[\w.+-]+@[\w-]*[-.:][\w.:-]*(?:['’]s)?$/;

/**
 * A word that can only be a password by its shape, wherever it stands ("Netflix is Winter#2024", "VPN = Summer2024!",
 * "Uses the same Winter#2024 everywhere"): six or more characters with letters, digits and a password's symbol, never an
 * address, a handle, a hashtag, a path, a glob, a price or code (memory-x9-6).
 */
function symbolValue(text: string): boolean {
  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^[("'“]+|[)"'”.,;:?]+$/g, "");
    if (w.length < 6 || !/[A-Za-z]/.test(w) || !/\d/.test(w) || !/[!@#$%&*]/.test(w)) continue;
    // A handle, a hashtag, a price, a path or a glob, code, an address or a user at a host ("deploy@build-01").
    if (/^[@#$£€~.]|[/\\()[\]{}<>=`|;"]/.test(w) || AT_HOST.test(w)) continue;
    return true;
  }
  return false;
}

/** What a code of digits opens or is for, by one word ("Garage keypad 4821", "Voicemail is 4821", "Withdraws cash with 4821"). */
const CODE_NOUN = /^(?:keypad|padlock|lock|combination|combo|alarm|safe|door|gate|garage|voicemail|atm|cash|passcode|unlock\w*|disarm\w*|punch\w*|card|sim|phone|iphone|ipad|tablet|laptop)$/i;
/** A lock that takes three digits as well ("Luggage lock 482", "Suitcase combination 482"). */
const THREE_DIGIT = /^(?:padlock|lock|combination|combo)$/i;
/** A word just before the digits that makes them a time, a year, a place, a price or a count ("at 0900", "level 4821", "costs 1200"). */
const NOT_CODE_BEFORE = /^(?:a|an|the|at|from|until|till|by|before|after|around|about|over|under|of|in|since|for|level|extension|ext|flat|room|locker|order|flight|ticket|employee|space|platform|route|bus|model|year|costs?|paid|pays|worth|ends|ending|last|unit|suite|house|building|zip|postcode|between|and)$/i;
/** A word just after the digits that makes them an address, a size, a count or a time ("4821 Elm Street", "1200 wide", "5000 points"). */
const NOT_CODE_AFTER = /^(?:street|st|road|rd|avenue|ave|lane|ln|way|drive|dr|close|court|crescent|place|terrace|boulevard|blvd|lines?|words?|points?|metres?|meters?|m|mm|cm|km|miles?|feet|ft|inches|wide|tall|high|long|deep|pixels?|px|times|days?|hours?|hrs|minutes?|mins|seconds?|years?|months?|weeks?|people|steps|documents|files|items|photos|books|songs|cars|model|edition|series|calories|kcal|rpm|watts?|w|mah|train|bus|flight|am|pm|every|each|daily|onwards|pounds|dollars|euros|quid|per|percent|a|an)$/i;

/**
 * Four to eight digits within five words of what a code opens, either side ("The door keypad takes 4821", "The padlock is
 * set to 4821", "Phone: 482913", "To disarm, press 4821"), unless the word beside them makes them something else
 * (memory-x9-6). Read only in a fact, one short sentence.
 */
function codeBeside(text: string): boolean {
  for (const clause of text.split(/[.;!?\n]+/)) {
    // A place's dialling code ("The phone code for Leeds is 0113", "the area code").
    if (/\b(?:dialling|dialing|area|country|std)\s+code\b|\bphone\s+code\s+for\b/i.test(clause)) continue;
    const words = clause.split(/\s+/).filter(Boolean);
    const clean = words.map(w => w.replace(/^[("'“]+|[)"'”,:]+$|['’]s$/g, ""));
    for (let i = 0; i < words.length; i++) {
      // Digits as one word or joined by dashes ("4821", "4821#", "32-18-04"), never a phone number in two parts.
      const m = /^["'“(]?#?(\d(?:-?\d){2,7})[#*]?[)"'”,:]?$/.exec(words[i]!);
      if (!m) continue;
      if (/^\d/.test(clean[i + 1] ?? "") || /\d$/.test(clean[i - 1] ?? "")) continue;
      const n = m[1]!.replace(/-/g, "").length;
      const before = (clean[i - 1] ?? "").toLowerCase(), after = (clean[i + 1] ?? "").toLowerCase();
      // "Punches in 4821", "Keys in 4821": "in" after a verb of typing is no place or time.
      const typedIn = before === "in" && /^(?:punch|key|tap|type|enter)\w*$/i.test(clean[i - 2] ?? "");
      if ((NOT_CODE_BEFORE.test(before) && !typedIn) || NOT_CODE_AFTER.test(after)) continue;
      if (after === "on" && /^(?:weekdays|weekends|\w+days)$/i.test(clean[i + 2] ?? "")) continue;
      if ((after === "and" || after === "or") && /^(?:newer|later|older|earlier)$/i.test(clean[i + 2] ?? "")) continue;
      if (after === "in" && /^cash$/i.test(clean[i + 2] ?? "")) continue;
      if (clean.slice(i + 1, i + 4).some(w => /^(?:street|road|avenue|lane|way|drive|close|court|crescent|terrace|boulevard)$/i.test(w))) continue;
      const near = [...clean.slice(Math.max(0, i - 6), i), ...clean.slice(i + 1, i + 7)];
      if (n >= 4 && near.some(w => CODE_NOUN.test(w))) return true;
      if (n === 3 && [...clean.slice(Math.max(0, i - 2), i)].some(w => THREE_DIGIT.test(w))) return true;
    }
  }
  return false;
}

/**
 * "Router admin is admin123", "Default login admin/admin123", "Root is Summer2024!": a value after an administrator's
 * name, or after a login's with a symbol or a user before it (never "The GitHub login is octocat2", a user's name).
 */
const ADMIN_VALUE = /\b(?:admin|administrator|root|login|sudo|superuser)\b(?:\s+(?:is|was)\s+|\s*[:=]\s*|\s+)["'“]?(?:[A-Za-z][\w.-]{0,30}\/)?(?<value>[^\s"'”/]+)/gi;
function adminValue(text: string): boolean {
  for (const m of text.matchAll(ADMIN_VALUE)) {
    const v = bare(m.groups!.value!);
    if (AT_HOST.test(v)) continue;
    if (/[!@#$%^&*]/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v)) return true;
    // A login's name alone is a user's ("The GitHub login is octocat2"); with a user before it, it is the password.
    if ((!/^login$/i.test(m[0].split(/\W/)[0]!) || /\//.test(m[0])) && secretShaped(v) && !PRODUCT.test(v) && !AMOUNT.test(v)) return true;
  }
  return false;
}

/** "Hotspot password-free, key BlueSky99": a network's key said with no "is", never its standard ("Network key: WPA2-PSK"). */
const NETWORK_KEY = /\b(?:wi-?fi|hotspot|network|router)\b[^.;!?\n]{0,60}?\bkey\s*[:=]?\s+["'“]?(?![A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+(?:[\s.,;!?"'”]|$))(?=[^\s"'”]{0,64}[0-9!@#$%^&*])(?=[^\s"'”]*[A-Za-z])[^\s"'”]{6,}/i;
/** A security question's answer said beside it ("First pet was called Biscuit (security question)", "Security question: Biscuit"). */
const SECURITY_QUESTION = /\(\s*(?:for\s+(?:the|a|my)\s+)?(?:security|secret)\s+questions?\s*\)|\b(?:security|secret)\s+questions?\s*[:=]\s*\S|\b(?:for|as)\s+(?:the|a|my|their)\s+(?:bank['’]s\s+)?(?:security|secret)\s+questions?\b/i;
/** "Passport number 123456789", "Driving licence: MORGA753116SM9IJ". */
const ID_DOCUMENT = /\b(?:passport|driving\s+licen[cs]e|driver['’]?s\s+licen[cs]e)(?:\s+(?:number|no\.?|#))?\s*(?:(?:is|was)\s+|[:=]\s*)?["'“]?(?=[A-Z0-9]*\d)[A-Z0-9]{6,18}\b/i;

/**
 * A password's or a PIN's own name (never a postal "PIN code", which `BESIDE_SHAPES` keeps), and what it heads when it
 * names no value ("password manager", "PIN reset", "password rules").
 */
const SECRET_NAME = String.raw`(?:password|passcode|passphrase|passwd|pin(?![\s-]*code))s?\b(?!['’]s\b)(?![\s-]+(?:managers?|apps?|vault|keeper|generator|hints?|resets?|rules?|polic(?:y|ies)|requirements?|strength|fields?|box|prompts?|screens?|pages?|changes?|expiry|history|length|entr(?:y|ies)|lists?|files?|protect\w*|less|free)\b)`;
/** Words that say no value where one would stand ("It is my password that expired", "Forgot their password, again"). */
const NOT_SAID = /^(?:i|you|he|she|we|they|me|him|them|us|mine|yours|hers|ours|theirs|what|which|who|whatever|something|nothing|everything|anything|one|again|though|however|sadly|apparently|twice|recently|yesterday|today|written|noted|somewhere|ready|then)$/i;
const sayless = (v: string) => NO_VALUE.test(v) || NOT_SAID.test(v);
/** A value as a word or a quoted phrase, never a word that says none (so "is the same: sunshine" reads on to "sunshine"). */
const SAID_VALUE = String.raw`(?!(?:${NOT_A_VALUE})(?:[\s"'”.,;:!?]|$))(?<value>["“][^"”\n]{1,40}["”]|[^\s"'”.,;:!?]{2,40})`;
/** "sunshine is my Netflix password", "Rex is their bank PIN": the value before its name (memory-r10-1). */
const VALUE_FIRST = new RegExp(String.raw`(?:^|[.;!?:,]\s*|\b(?:and|but|so)\s+)${SAID_VALUE}["'”]?\s+(?:is|was|=)\s+${NOW}${WHOSE}\s+(?:[\w'’.+-]+\s+){0,3}?${SECRET_NAME}`, "gi");
/** "The password I use is sunshine", "The PIN they use is the same everywhere: sunshine": the name, who uses it, then the value. */
const NAME_THEN_USER = new RegExp(String.raw`\b${SECRET_NAME}\s+(?:that\s+)?(?:i|you|we|they|he|she)\s+(?:\w+\s+)?(?:use[sd]?|chose|choose|picked|pick|set|have|has|had|made|gave|went\s+with)\b[^.;!?\n]{0,40}?(?:\s+(?:is|was|=)\s+|\s*:\s*)${NOW}["'“]?${SAID_VALUE}`, "gi");
/** "Uses purple monkey dishwasher as a password", "I use sunshine as my password everywhere": a word or a phrase used as one. */
const AS_SECRET = new RegExp(String.raw`\buse[sd]?\s+(?!as\b)(?:[^\s.;!?]+\s+){1,6}?as\s+(?:${WHOSE}\s+)?(?:[\w'’-]+\s+){0,2}?${SECRET_NAME}`, "i");
/** "I use the same password, sunshine, everywhere", "Password is the dog's name, Rex": the value set off by a comma. */
const APPOSED = new RegExp(String.raw`\b${SECRET_NAME}[^.;!?\n]{0,60}?,\s*["'“]?(?<value>[^\s,.;!?"'”]{2,40})["'”]?\s*(?:,|[.!?;]?\s*$)`, "gi");
/** "Has the password sunshine for Netflix", "Set the passcode as Fido": a verb of having or choosing, the name, then the value. */
const HAS_THE = new RegExp(String.raw`\b(?:has|have|had|got|gets|chose|chooses|picked|picks|set|sets|made|makes|gave|gives)\s+(?:${WHOSE}|one)\s+(?:[\w'’-]+\s+){0,2}?${SECRET_NAME}\s+(?:(?:of|as|to)\s+)?["'“]?${SAID_VALUE}`, "gi");
/** "For Netflix I use sunshine": a service's name, then what is used for it, alone at the clause's end. */
const FOR_SERVICE = new RegExp(String.raw`\bfor\s+(?:${SERVICES})\s*,?\s+(?:(?:i|we|they|he|she)\s+)?use[sd]?\s+["'“]?(?<value>[^\s"'”.,;!?]{2,40})["'”]?\s*(?:[.!?]?\s*$|[,;])`, "gi");
/** "The Netflix login is ram and sunshine": a login said as a user and a value. */
const LOGIN_AND = new RegExp(String.raw`\blogin\s+(?:is|was|:)\s+["'“]?[A-Za-z][\w.@-]{1,40}["'”]?\s+(?:and|with|plus|&)\s+["'“]?(?<value>[^\s"'”.,;!?]{2,40})`, "gi");
/** "Remember: hunter2 for the VPN", "Winter2024 on Netflix": a value shaped like a password where a clause starts, then what it is for. */
const VALUE_FOR = new RegExp(String.raw`(?:^|[:.;!?]\s*)["'“]?(?<value>[^\s"'”]{4,40})["'”]?\s+(?:for|on)\s+(?:${WHOSE}\s+)?(?:[\w'’-]+\s+){0,2}?(?:${SERVICES}|${PASSWORDED}|router|login|account|${DEVICES})\b`, "gi");
function valueFor(text: string): boolean {
  for (const m of text.matchAll(VALUE_FOR)) { const v = bare(m.groups!.value!); if (strict(v) && !PRODUCT.test(v)) return true; }
  return false;
}
/** A password's or a PIN's name anywhere in a sentence, for its digits (never a postal "PIN code"). */
const NAMES_SECRET = /\b(?:password|passcode|passphrase|passwd|pin(?![\s-]*code))s?\b/i;
const TIME_WORD = /^(?:in|since|from|until|till|by|of|before|after|around|during|year|circa)$/i;

/** Whether any match of `re` has a value that says something ("sunshine", never "it" or "the"). */
const valued = (re: RegExp, text: string) => [...text.matchAll(re)].some(m => !sayless(bare(m.groups!.value!)));

/**
 * Four to eight digits anywhere in a sentence that names a password, a PIN or a passcode ("My bank PIN is my birthday,
 * 0412", "Their passcode matches the year we met, 1998"), never a year said as a time ("Changed their password in 2024")
 * nor a count or a size by its word after it.
 */
function digitsBesideName(text: string): boolean {
  for (const clause of text.split(/[.;!?\n]+/)) {
    if (!NAMES_SECRET.test(clause)) continue;
    const words = clause.split(/\s+/).filter(Boolean).map(w => w.replace(/^[("'“#]+|[)"'”,:#*]+$/g, ""));
    for (let i = 0; i < words.length; i++) {
      if (!/^\d(?:-?\d){3,7}$/.test(words[i]!)) continue;
      if (/^(?:19|20)\d\d$/.test(words[i]!) && TIME_WORD.test(words[i - 1] ?? "")) continue;
      if (NOT_CODE_AFTER.test(words[i + 1] ?? "") || /^(?:characters?|chars?|letters?|digits?)$/i.test(words[i + 1] ?? "")) continue;
      return true;
    }
  }
  return false;
}

/**
 * A password's or a PIN's name for `valueInClause` (a PIN in lower case only after whose it is): its own words, the short ones people type (pwd, pw; "pass" after a
 * service's name or before a colon) and the names in French, Spanish, German and Portuguese. Never what heads a tool
 * (a password manager, app, vault, keeper or generator), nor a postal "PIN code".
 */
const CLAUSE_NAME = new RegExp(String.raw`\b(?:(?:password|passcode|passphrase|passwd|(?:${WHOSE}|card|bank|phone|sim|debit|credit|atm)\s+pin(?![\s-]*code)|pwd|pw|p\/w|pword|pass\s+(?:word|code))s?\b(?![\s-]+(?:managers?|apps?|vault|keeper|generators?)\b)`
  + String.raw`|(?:${SERVICES})\s+pass\b|^\s*pass\s*[:=]|mot\s+de\s+passe|contrase[ñn]a|passwort|senha)`, "i");
/**
 * Words a sentence about a password or a PIN may hold beside its name without holding its value: grammar, how people
 * talk about keeping, changing, forgetting and typing one, where it is kept, how long and how often. Any other word of
 * three letters or more in that clause may be the value, so the clause is refused (r10-memory-x10-1).
 */
const ABOUT_SECRET = new Set(String.raw`a an the my your our their his her its this that these those it i you he she we they me him them us mine yours
  is are was were be been being am has have had having do does did done will would can could should may might must shall
  not no nor never always often usually sometimes again still also too very just only even ever yet already once twice thrice
  and or but so if when while because though although as at by for from in into on onto of off out over to up down with without
  about after before since until till during through per every each all any some few many more most less least other another same
  different new old own first last next one two three four five six seven eight nine ten few several what which who whose how why
  where there here then than now today yesterday tomorrow recently lately soon monthly weekly yearly daily annually regularly
  password passwords passcode passcodes passphrase passphrases passwd pin pins pwd pw pass code codes number numbers digit digits
  character characters chars letter letters symbol symbols word words length long short longer shorter strong stronger weak weaker
  secure safe safely unsafe complex simple easy hard memorable unique random reused
  forgot forget forgets forgetting forgotten change changes changed changing reset resets resetting update updates updated updating
  expire expires expired expiring expiry renew renews renewed keep keeps kept keeping store stores stored storing save saves saved
  write writes wrote written writing note notes noted share shares shared sharing lose loses lost need needs needed want wants wanted
  ask asks asked asking type types typed typing enter enters entered entering use uses used using set sets setting choose chooses chose
  chosen make makes made get gets got gotten getting send sends sent give gives gave given know knows knew known remember remembers
  remembered recover recovers recovered locked lock lose sign signs signed signing log logs logged logging prefer prefers preferred
  like likes hate hates require requires required need wrong right correct incorrect again manager managers app apps vault keeper
  generator generators field fields box boxes prompt prompts screen screens page pages hint hints rule rules policy policies
  requirement requirements email emails text texts message messages link links request requests reminder reminders
  account accounts card cards debit credit bank banking sim phone phones mobile laptop computer tablet work home office school
  wifi wi-fi router email login logins device devices drawer notebook paper desk wallet somewhere place places safe envelope
  family partner wife husband kids children mum dad parents friend friends colleague colleagues boss
  month months week weeks year years day days hour hours minute minutes time times few couple
  times attempt attempts try tries tried
  hashed hash hashes masked salted encrypted encoded hidden entered protected redacted obscured starred cost
  passkey passkeys pword much instead ember sticker label underneath under behind back front inside bottom top`.split(/\s+/).filter(Boolean));
/** A password manager's or a sign-in tool's name, which a sentence about passwords names without holding one. */
const TOOL_NAME = /^(?:1password|bitwarden|lastpass|keepass(?:xc)?|dashlane|keeper|nordpass|proton\s*pass|keychain|authy|okta|sso|2fa|mfa|totp|otp|face|touch|id|yubikey)$/i;
const SERVICE_WORD = new RegExp(String.raw`^(?:${SERVICES})$`, "i");

/**
 * A word that may be the value in a clause that names a password or a PIN (CLAUSE_NAME), whatever the word order
 * (r10-memory-x10-1): "sunshine's my Netflix password", "My Netflix password? sunshine.", "Netflix pw sunshine". A
 * clause runs to a full stop, ";", "!" or a line's end, across "?", "—", "→", "/", commas, "…" and into a next sentence
 * that opens "It is", "Now it's" or "That's" (r10-memory-y10-3). A word is the value
 * unless it is in ABOUT_SECRET, a service's or a tool's name, or a number (`digitsBesideName` reads a PIN's digits).
 * Fail closed: an unknown word beside a password's name costs the fact, never the password.
 */
/** A password's or a PIN's name in a clause, as `topicOnly` reads it. */
const TOPIC_NAME = /^(?:passwords?|passcodes?|passphrases?|passwd|pins?|pwd|pw|pword)$/i;
/** What a password's or a PIN's name heads when it is a topic ("password resets", "PIN pad", "password policy", "PIN unblocks"). */
const TOPIC_HEAD = /^(?:resets?|unlocks?|unblocks?|polic(?:y|ies)|rules?|flows?|services?|teams?|pads?|entry|entries|screens?|pages?|audits?|hygiene|management|managers?|guidance|security|storage|expiry|changes?|requirements?|strength|support|recovery|sync|sharing|vaults?|apps?|tools?|systems?|projects?|migrations?|rotation|training|forms?|fields?|prompts?|length|complexity|readers?|terminals?|firmware|tickets?|requests?|issues?|queries|calls?)$/i;
/** Whose a plural is ("my passwords"): then it holds values. */
const OWNER = /^(?:my|our|your|his|her|their|its)$/i;
/** What opens a phrase after a topic that says where or for whom ("…at Globex", "…for card holders", "…and laptops"). */
const PHRASE_START = /^(?:at|for|in|on|of|across|within|from|by|and|or|over|around|throughout)$/i;
/** Words that pass through such a phrase without ending it. */
const DETERMINER = /^(?:a|an|the|my|your|our|their|his|her|its|this|these|those)$/i;
/** The words of ABOUT_SECRET that are things or places, which such a phrase may name ("…for the banking app", "…at home"). */
const PHRASE_NOUN = new Set(String.raw`account accounts card cards debit credit bank banking sim phone phones mobile laptop computer tablet work home
  office school wifi wi-fi router email emails login logins device devices desk family partner kids children friends colleagues
  app apps manager managers vault page pages screen screens field fields box boxes text texts message messages link links`.split(/\s+/).filter(Boolean));
/** The words of PHRASE_NOUN that qualify the phrase's head rather than name it ("…for card holders", "…for the banking app"). */
const PHRASE_MODIFIER = /^(?:card|cards|debit|credit|sim|banking|wifi|wi-fi|email)$/;
/** A word of letters and digits, which a sentence about passwords as a topic doesn't hold ("…for Globex Bluebird77"). */
const LETTERS_AND_DIGITS = /^(?=(?:[^a-z]*[a-z]){3})(?=[^\d]*\d)\S+$/i;
/** A verb that puts a value to use ("Use tangerine for password resets", "Types marmalade on the PIN pad"). */
const USE_VERB = /^(?:use[sd]?|using|set|sets|setting|enters?|entered|types?|typed|tr(?:y|ies|ied)|cho(?:se|ose|oses)|picks?|picked|puts?)$/i;
/** A word that is no grammar, no talk about passwords and no tool's or service's name, so may be a value. */
const mayBeValue = (t: string) => !!t && !DETERMINER.test(t) && !ABOUT_SECRET.has(t) && !sayless(t) && !TOOL_NAME.test(t) && !SERVICE_WORD.test(t);
/**
 * Whether every password's or PIN's name in `clause` is a topic, never a value's name (memory-r11-2): a name that heads
 * a topic word ("password resets", "the PIN pad"), or a plural no one owns ("reset passwords", "the LDAP passwords").
 * Every word after the topic's own words, up to the next such name, is read (r11-memory-x11-1): grammar and talk about
 * passwords (ABOUT_SECRET), or a word in a phrase that says where or for whom ("…at Globex", "…and laptops"). Any other
 * word is the value ("Password reset code is tangerine", "Passwords at home all start with marmalade"), and so is one set
 * off by ":", "=", "to", "as", a dash, a verb or a copula, which each end such a phrase. Fail closed.
 */
function topicOnly(clause: string): boolean {
  const tokens = clause.split(/\s+/).filter(Boolean);
  let named = false;
  for (const [i, raw] of tokens.entries()) {
    const w = word(raw);
    if (!TOPIC_NAME.test(w)) continue;
    named = true;
    // The topic's words after the name ("reset flow", "pad firmware"), none of them set off by ":" or "=".
    let j = i + 1;
    if (!/[:=]$/.test(raw)) while (j < tokens.length && TOPIC_HEAD.test(word(tokens[j]!)) && !/[:=]$/.test(tokens[j - 1]!)) j++;
    const head = j > i + 1;
    const plural = /s$/i.test(w) && !tokens.slice(Math.max(0, i - 3), i).some(t => OWNER.test(word(t)));
    if (!head && !plural) return false;
    if (/[:=]$/.test(tokens[j - 1]!)) return false;
    // A word used or set before the topic is its value too ("Use tangerine for password resets").
    if (tokens.slice(0, i).some((t, k) => USE_VERB.test(word(t)) && mayBeValue(word(tokens[k + 1] ?? "").toLowerCase()))) return false;
    // A phrase names one thing (r11-memory-y11-1): modifiers, then one head word; a further word is the value
    // ("Passwords for my laptop marmalade", "Password resets for Globex Bluebird77").
    let phrase = false;
    let heads = 0;
    let afterName = false;
    for (let k = j; k < tokens.length; k++) {
      const t = word(tokens[k]!).toLowerCase();
      // The next name is read on its own, by the loop above.
      if (TOPIC_NAME.test(t)) break;
      const name = afterName;
      afterName = false;
      if (PHRASE_START.test(t)) { phrase = true; heads = 0; }
      else if (DETERMINER.test(t)) { /* passes through */ }
      else if (!t || /^[-–—→]+$/.test(t)) phrase = false;
      else if (ABOUT_SECRET.has(t) || sayless(t) || /^[a-z]+['’](?:s|t|re|ve|ll|d|m)$/.test(t)) {
        if (!PHRASE_NOUN.has(t)) phrase = false;
        // A place or a thing is a head ("…at home", "…for my laptop"), but a modifier ("…for card holders") or what a service's name heads ("…the Netflix account").
        else if (phrase && !PHRASE_MODIFIER.test(t) && !name && ++heads > 1) return false;
      }
      // A word that may be the value: only one place's, group's or thing's name in such a phrase, never one alone after a comma at the clause's end.
      else if (!phrase || ++heads > 1 || (k === tokens.length - 1 && /,$/.test(tokens[k - 1]!))) return false;
      else afterName = TOOL_NAME.test(t) || SERVICE_WORD.test(t);
      if (/[:=]$/.test(tokens[k]!)) phrase = false;
    }
  }
  return named;
}

function valueInClause(text: string): boolean {
  // "p.w." is the name, "..." and "…" go on with the clause, and "It is…", "Now it's…", "That's…" go on with the sentence
  // before (r10-memory-y10-3).
  const joined = text.replace(/\bp\.w\.?/gi, " pw ").replace(/\.{2,}|…/g, " , ")
    .replace(/[.!?]\s+(?=(?:now\s+|and\s+)?(?:it\s+is|it['’]s|that\s+is|that['’]s)\b)/gi, " , ");
  const parts = joined.split(/([.;!\n]+(?:\s|$))/);
  for (let c = 0; c < parts.length; c += 2) {
    const clause = parts[c]!;
    // A PIN in capitals anywhere; "pin" in lower case only after whose it is, so "Likes to pin recipes" names none.
    if (!CLAUSE_NAME.test(clause) && !/\bPINs?\b(?![\s-]*code)/.test(clause)) continue;
    // Passwords as a topic, not a value ("IT support: password resets and laptops"): only a value's shape counts (memory-r11-2).
    if (topicOnly(clause)) {
      if (clause.split(/\s+/).some(w => passwordShaped(w) || (LETTERS_AND_DIGITS.test(word(w)) && !TOOL_NAME.test(word(w)) && !SERVICE_WORD.test(word(w))) || /["“]/.test(w))) return true;
      // A topic goes on across ";" ("I handle password resets; the default is marmalade", r11-memory-y11-1).
      if (/;/.test(parts[c + 1] ?? "") && parts[c + 2]?.trim() && !topicOnly(`${clause} ${parts[c + 2]}`)) return true;
      continue;
    }
    const words = clause.replace(/mot\s+de\s+passe|contrase[ñn]a|passwort|senha/gi, " ").replace(/->|[→—–]|\s-+\s/g, " ")
      .split(/[\s,:?()"“”=/]+/).map(w => w.replace(/['’]s$/i, "").replace(/^['‘’]+|['‘’]+$/g, "")).filter(Boolean);
    for (const [i, w] of words.entries()) {
      const lw = w.toLowerCase();
      // Three digits or more beside the name are its value, but a year after a time word or a count before what it counts (r10-memory-y10-3).
      if (/^\d{3,}$/.test(lw) && !(/^(?:19|20)\d\d$/.test(lw) && TIME_WORD.test(words[i - 1] ?? "")) && !NOT_CODE_AFTER.test(words[i + 1] ?? "")
        && !/^(?:characters?|chars?|letters?|digits?)$/i.test(words[i + 1] ?? "")) return true;
      if (/^\d+$|^[*•·.]+$/.test(lw) || ABOUT_SECRET.has(lw) || TOOL_NAME.test(lw) || SERVICE_WORD.test(lw) || sayless(lw) || ALGORITHM.test(lw)) continue;
      if (/^(?:[a-z]+['’](?:s|t|re|ve|ll|d|m))$/i.test(lw)) continue;
      if (lw.length >= 3 || /["“]/.test(w)) return true;
    }
  }
  return false;
}
/** "bluebird is what I use for Gmail", "Sunshine99 is what I type for Netflix": a value, then what it is typed for. */
const WHAT_I_TYPE = new RegExp(String.raw`(?:^|[.;!?:,]\s*)["'“]?(?<value>[^\s"'”.,;:!?]{2,40})["'”]?\s+is\s+what\s+(?:i|we|you|they|he|she)\s+(?:type|use|enter|put|key)s?\s+(?:for|on|in|into|at)\s+(?:${WHOSE}\s+)?(?:[\w'’-]+\s+){0,2}?(?:${SERVICES}|${PASSWORDED}|router|login|account|${DEVICES}|${LOCKED})\b`, "gi");
/** "Netflix login: ram / sunshine", "Gmail sign-in: ram, bluebird": a login's user and its value after the login's name, any value. */
const LOGIN_PAIR = new RegExp(String.raw`\b(?:login|log-in|sign-in|credentials?)\s*[:=]\s*["'“]?[A-Za-z][\w.@-]{1,40}["'”]?\s*(?:/|,|\band\b)\s*["'“]?(?<value>[^\s"'”.,;!?]{2,40})`, "gi");

/**
 * A password or a PIN said in an everyday word order (memory-r10-1): the value before its name, after who uses it, set off
 * by commas, after "has the password", as a phrase "used as" one, beside its digits, what is used for a service, or a
 * value shaped like one before what it is for.
 * Memory's note promises it keeps none however it is said, so the guard reads each order, not only "password is X".
 */
function inWordOrder(text: string): boolean {
  return valued(VALUE_FIRST, text) || valued(NAME_THEN_USER, text) || AS_SECRET.test(text) || valued(APPOSED, text) || valued(HAS_THE, text)
    || digitsBesideName(text) || valued(FOR_SERVICE, text) || valued(LOGIN_AND, text) || valueFor(text)
    || valued(WHAT_I_TYPE, text) || valued(LOGIN_PAIR, text) || valueInClause(text);
}

/** Why `text` may not be remembered as a fact, or null when it may: `memoryRefusal`, then what only a fact is read for. */
export function factRefusal(text: string): string | null {
  return memoryRefusal(text) ?? saidSecret(text);
}
