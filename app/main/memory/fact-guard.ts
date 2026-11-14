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
const CLAUSE_NAME = new RegExp(String.raw`\b(?:(?:password|passcode|passphrase|passwd|(?:${WHOSE}|card|bank|phone|sim|debit|credit|atm)\s+pin(?![\s-]*code)|pwd|pw)s?\b(?![\s-]+(?:managers?|apps?|vault|keeper|generators?)\b)`
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
  passkey passkeys instead ember sticker label underneath under behind back front inside bottom top`.split(/\s+/).filter(Boolean));
/** A password manager's or a sign-in tool's name, which a sentence about passwords names without holding one. */
const TOOL_NAME = /^(?:1password|bitwarden|lastpass|keepass(?:xc)?|dashlane|keeper|nordpass|proton\s*pass|keychain|authy|okta|sso|2fa|mfa|totp|otp|face|touch|id|yubikey)$/i;
const SERVICE_WORD = new RegExp(String.raw`^(?:${SERVICES})$`, "i");

/**
 * A word that may be the value in a clause that names a password or a PIN (CLAUSE_NAME), whatever the word order
 * (r10-memory-x10-1): "sunshine's my Netflix password", "My Netflix password? sunshine.", "Netflix pw sunshine". A
 * clause runs to a full stop, ";", "!" or a line's end, across "?", "—", "→", "/" and commas. A word is the value
 * unless it is in ABOUT_SECRET, a service's or a tool's name, or a number (`digitsBesideName` reads a PIN's digits).
 * Fail closed: an unknown word beside a password's name costs the fact, never the password.
 */
function valueInClause(text: string): boolean {
  for (const clause of text.split(/[.;!\n]+(?:\s|$)/)) {
    // A PIN in capitals anywhere; "pin" in lower case only after whose it is, so "Likes to pin recipes" names none.
    if (!CLAUSE_NAME.test(clause) && !/\bPINs?\b(?![\s-]*code)/.test(clause)) continue;
    const words = clause.replace(/mot\s+de\s+passe|contrase[ñn]a|passwort|senha/gi, " ").replace(/->|[→—–]|\s-+\s/g, " ")
      .split(/[\s,:?()"“”=/]+/).map(w => w.replace(/['’]s$/i, "").replace(/^['‘’]+|['‘’]+$/g, "")).filter(Boolean);
    for (const w of words) {
      const lw = w.toLowerCase();
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
