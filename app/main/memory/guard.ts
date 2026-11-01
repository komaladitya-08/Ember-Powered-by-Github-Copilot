/**
 * What Ember's memory never keeps. A fact is refused whole, never stored redacted, when it holds a secret: a token or
 * key (the commands redactor's patterns, commands/redact.ts), a card number, or words that say a password, PIN or code
 * follows. Memory outlives the conversation, so a secret kept there would outlive it too (CLAUDE.md: password text
 * never reaches the model). Best effort, as the redactor is: what it never does is keep what it noticed.
 */

import { redactSecrets } from "../commands/redact";

/** "my password is…", "PIN: 1234", "the wifi key is…": a secret's name, then its value. */
const TOLD_SECRET =
  /\b(?:pass(?:word|phrase|code|wd)|pin|passcode|otp|2fa code|verification code|recovery (?:code|key)|seed phrase|security answer|cvv|cvc|wi-?fi (?:key|password))s?\b\s*(?:is|was|=|:|-)\s*\S+/i;

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
  if (redactSecrets(text) !== text) return "it holds a password, token or key";
  if (TOLD_SECRET.test(text)) return "it holds a password, PIN or code";
  for (const m of text.match(CARD) ?? []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 13 && luhn(digits)) return "it holds a card number";
  }
  return null;
}
