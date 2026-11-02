/**
 * What Ember's memory never keeps. A fact is refused whole, never stored redacted, when it holds a secret: a token or
 * key (the commands redactor's patterns, commands/redact.ts), a card number, or words that say a password, PIN or code
 * follows. Memory outlives the conversation, so a secret kept there would outlive it too (CLAUDE.md: password text
 * never reaches the model). Best effort, as the redactor is: what it never does is keep what it noticed.
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
].join("|");

/**
 * A secret's name with one of those words where its value would be ("Password: changed yesterday"): taken out before
 * the redactor looks, which would otherwise take "changed" for the password.
 */
const NAMED_NO_VALUE = new RegExp(
  String.raw`(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*(?:=|:)\s*["']?(?:${NOT_A_VALUE})(?=[\s.,;!?"']|$)`,
  "gi",
);

/** "my password is…", "PIN: 1234", "the wifi key is…": a secret's name, then its value (not a word like "required"). */
const TOLD_SECRET = new RegExp(
  String.raw`\b(?:pass(?:word|phrase|code|wd)|pin|passcode|otp|2fa code|verification code|recovery (?:code|key)|seed phrase|security answer|cvv|cvc|wi-?fi (?:key|password))s?\b\s*(?:is|was|=|:|-)\s*["'“]?(?!(?:${NOT_A_VALUE})(?:[\s.,;!?"'”]|$))\S+`,
  "i",
);

/** A private key's armour header ("-----BEGIN OPENSSH PRIVATE KEY-----"), on its own: refused without its END line. */
const PRIVATE_KEY_START = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/i;

/** A run of 13 to 19 digits (spaces or dashes between groups) that passes the Luhn check: a payment card. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;

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
  if (TOLD_SECRET.test(text)) return "it holds a password, PIN or code";
  for (const m of text.match(CARD) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) return "it holds a card number";
  }
  return null;
}
