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
/** "The front door is 4821", "Front door: 4821", "The alarm is 4821"; and the lock with its digits alone ("Front door 4821"). */
const LOCK_IS = new RegExp(String.raw`\b(?:${LOCKED})\b(?:\s+(?:is|was)\s+|\s*:\s*)${NOW}${DIGITS}`, "i");
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
/** "My secret is hunter2", "The secret is Tr0ub4dor&3": never "the secret is patience". */
const A_SECRET = new RegExp(String.raw`\b(?:my|our|the|his|her|their)\s+secret\s+(?:is|was)\s+${NOW}["'“]?${LOGIN_VALUE}`, "i");
/** A bank's memorable word or information, a secret or security word, a secret answer: any word after it but one that says no value. */
const SECRET_WORD = new RegExp(String.raw`\b(?:memorable\s+(?:word|phrase|information|info|place|name|date|answer)|(?:secret|security)\s+(?:word|phrase)|secret\s+answer|telephone\s+(?:banking\s+)?(?:password|passcode|code))s?\b`
  + String.raw`${FOR_WHAT}${SAYS}${NOW}["'“]?(?!(?:${NOT_A_VALUE}|asked|used|what|something|one)(?:[\s.,;!?"'”]|$))\S+`, "i");
/** "pswd: hunter2", "p/w hunter2", "My passkey is hunter2"; "pass: hunter2" and "the pass is hunter2", never a bus pass or tests that pass. */
const SHORT_PASS = new RegExp(String.raw`(?:\b(?:pswd|passkey)\b|(?<![\w/])p\/w(?![\w/]))${FOR_WHAT}(?:${SAYS}|\s+)["'“]?(?=[^\s"'”]{0,64}[0-9!@#$%^&*])[^\s"'”]{4,}`, "i");
const THE_PASS = new RegExp(String.raw`(?:^\s*pass\s*[:=]\s*|\b(?:the|my|our|his|her|their)\s+pass\s+(?:is|was)\s+)["'“]?(?=[^\s"'”]*[A-Za-z])(?=[^\s"'”]*\d)${LOGIN_VALUE}`, "i");
/** A card's security digits said in words ("The card's three digits are 123", "Card security number 123"). */
const CARD_DIGITS = /\b(?:card(?:['’]s)?\s+(?:security|verification)\s+(?:number|code|digits?)|card['’]s\s+(?:three|3|four|4|security)\s+digits|(?:three|3|four|4)\s+digits\s+on\s+the\s+(?:back|front)(?:\s+of\s+(?:the|my|his|her|their)\s+card)?|security\s+(?:number|code)\s+on\s+the\s+(?:back|card))\b[^\d\n]{0,20}\d{3,4}(?!\d)/i;
/** A US account with its routing number, either first. */
const US_ACCOUNT = String.raw`\baccount(?:\s+(?:number|no\.?))?\b[^\d\n]{0,20}\d{6,17}(?!\d)`;
const US_ROUTING = String.raw`\brouting(?:\s+(?:number|no\.?))?\b[^\d\n]{0,20}\d{9}(?!\d)`;
const US_BANK = new RegExp(String.raw`${US_ACCOUNT}[^\n]{0,60}?${US_ROUTING}|${US_ROUTING}[^\n]{0,60}?${US_ACCOUNT}`, "i");

const NO_VALUE = new RegExp(String.raw`^(?:${NOT_A_VALUE})$`, "i");
const ALGORITHM = new RegExp(String.raw`^(?:${STATE_ALGORITHM})`, "i");
/** A product's name with its version ("Windows11", "Office365", "Node20"), and 1Password: a tool's name, never its password. */
const PRODUCT = /^(?:[A-Z][A-Za-z]*\d{1,3}|1[Pp]assword)$/;
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
    if (m.groups!.service ? strict(v) : /[!@#$%^&*]/.test(v) || (!!m.groups!.user && secretShaped(v) && !PRODUCT.test(v))) return true;
  }
  for (const m of text.matchAll(SERVICE_USES)) if (strict(bare(m.groups!.value!))) return true;
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

/** What takes a password said as it (THING_IS): a device only with a symbol in the value, since "iPhone15" is its model. */
function thingIs(text: string): boolean {
  for (const m of text.matchAll(THING_IS)) {
    const v = bare(m.groups!.value!);
    if (/^\d{6}(?:-\d{6})+$/.test(v) || /[!@#$%^&*]/.test(v) || (m.groups!.soft && secretShaped(v) && !AMOUNT.test(v))) return true;
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

/**
 * Why a fact may not be kept for what it says with a verb or under one of these names, in a few words for the model
 * to pass on, or null. Read only after `memoryRefusal` found nothing (`factRefusal`).
 */
export function saidSecret(text: string): string | null {
  if (VERB_WITH.test(text) || OPENS_WITH.test(text) || ENTERS.test(text) || uses(text) || pair(text) || LOCK_IS.test(text) || LOCK_BARE.test(text)
    || PLACE_S_CODE.test(text) || THE_CODE.test(text) || thingIs(text) || WIFI_THEN_KEY.test(text) || A_SECRET.test(text) || SECRET_WORD.test(text)
    || SHORT_PASS.test(text) || THE_PASS.test(text)) return "it holds a password, PIN or code";
  if (keySaid(text)) return "it holds a password, token or key";
  if (CARD_DIGITS.test(text)) return "it holds a card's security code";
  if (US_BANK.test(text)) return "it holds an account or ID number";
  return null;
}

/** Why `text` may not be remembered as a fact, or null when it may: `memoryRefusal`, then what only a fact is read for. */
export function factRefusal(text: string): string | null {
  return memoryRefusal(text) ?? saidSecret(text);
}
