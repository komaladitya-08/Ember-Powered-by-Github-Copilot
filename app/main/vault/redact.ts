/**
 * The vault's redactor (owner decision of 2026-11-12, PLAN.md §2 "Approvals", "The vault"): nothing Ember reads or
 * captures after a fill holds the value. Every value the vault hands to a field is noted here first, in memory only
 * and for this run only, and from then on it is replaced wherever text leaves main for a model (the runtime client's
 * prompts, system messages and tool results: redactingClient), for the audit log and for the logs. A password is never
 * read back from its field at all; this is for everything else: a user name or an email the page shows again, a
 * card number a receipt repeats, a value an app puts in its address or its title.
 *
 * What counts as the value: the text as filled; a card number or a phone number by its digits, whatever a site puts
 * between them, a phone number with its country code or without; an expiry as a month and a year however they are
 * written; the text as an address, a JSON line or markup escapes it, any of its characters as a numeric entity and
 * with characters that don't show inside it (vault-3-x9-5); with its accented letters composed or in parts; runs of white space of
 * any length (an address's lines joined by commas too); and, for the parts that aren't
 * secret (a user name, an email, an address), any letter case. A part that isn't secret is replaced only where
 * it stands alone (a user name "ada", an expiry's "12/27"), never inside a longer word or number ("adamant"), which
 * would say where it is without hiding anything; a password and a card number are replaced wherever they stand.
 *
 * A secret shorter than MIN_SECRET characters (a card's security code, a four-character password) is never looked for
 * in other text (review vault-3-x9-1): a mark in place of three digits says which three they are to anyone who knows
 * the text around it (a list of numbers, a date, a price), on any page for the rest of the run, and would turn every
 * control and field that has those digits in it secret. Such a value is kept from a model by its field alone, which is
 * secret from the fill on (the helper's fill and the worker's mark), never read and blacked out of every picture.
 *
 * Text cut short in the middle of a value before it gets here isn't recognised: readers that cut text ask `holds`
 * first (Perception does, for every element), and screen text is redacted whole before it is cut (perception/elements.ts
 * `setQuoteRedactor`, which main sets: review vault-3-x9-2).
 *
 * Plain Node, no Electron: the list lives in main's memory and is never written, sent or logged.
 */

import { SECRET_PARTS, type VaultPart } from "../../shared/vault";

/** What stands where a value was. It names no kind and no length. */
export const VAULT_REDACTED = "[hidden: filled from Ember's vault]";

/** A secret part with fewer characters than this is not looked for in other text (see above). */
const MIN_SECRET = 6;

/** Values watched at most (a run fills a handful): past this, `note` refuses, and so nothing more is filled in this run. */
const MAX_VALUES = 400;

/** Stands in for a value until every value has been looked for (a private-use character no text Ember reads means anything by). */
const MARK = "\ue000";
const MARKS = /\ue000+/g;

// Only what a pattern with the `u` flag lets be escaped: a "-" there is an error outside a character class.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The text as markup escapes it (quoted element text, a page's source). */
const asMarkup = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** The text inside a JSON string (a log line, a tool's JSON answer). */
const asJson = (s: string) => JSON.stringify(s).slice(1, -1);
/** The text in an address, with %20 or + for a space. */
function asAddress(s: string): string[] {
  try {
    const enc = encodeURIComponent(s);
    return [enc, enc.replace(/%20/g, "+")];
  } catch {
    return []; // a lone surrogate: no address holds it either
  }
}

/** Characters that don't show (a zero-width space, a soft hyphen, a direction mark): a page may put them anywhere in a value. */
const UNSEEN = "\\p{Cf}*";
/**
 * What may stand between two digits of a card or phone number as a site writes it again: up to three of anything but a
 * digit or a plain letter (measured: the Unicode classes here took 0.4 s a pattern over a 430,000-character read, these 3 ms).
 */
const BETWEEN_DIGITS = "[^0-9A-Za-z]{0,3}";
/** No letter or digit before, none after: the value stands alone. */
const NONE_BEFORE = "(?<![\\p{L}\\p{N}])";
const NONE_AFTER = "(?![\\p{L}\\p{N}])";

/** One character as it is, or as markup's numeric entity for it (&#64; or &#x40;, any case, any leading zeros). */
function character(c: string): string {
  const code = c.codePointAt(0)!;
  const hex = [...code.toString(16)].map(d => (/[a-f]/.test(d) ? `[${d}${d.toUpperCase()}]` : d)).join("");
  return `(?:${escapeRe(c)}|&#0*${code};|&#[xX]0*${hex};)`;
}

/**
 * The pattern that finds one form of a value: any of its characters may be a numeric entity, and characters that don't
 * show may stand anywhere inside (measured: 9 values over a 430,000-character read take about 50 ms).
 */
function pattern(form: string, o: { fold: boolean; alone: boolean }): RegExp {
  // Between its words, white space of any length, with the comma or semicolon an app joins an address's lines by.
  let body = form.split(/\s+/).map(word => [...word].map(character).join(UNSEEN)).join(`(?:[\\s,;]|\\p{Cf})+`);
  // Where it starts or ends with a letter or a digit, no letter or digit may stand against it.
  if (o.alone) body = `${/^[\p{L}\p{N}]/u.test(form) ? NONE_BEFORE : ""}${body}${/[\p{L}\p{N}]$/u.test(form) ? NONE_AFTER : ""}`;
  return new RegExp(body, o.fold ? "giu" : "gu");
}

/** A run of digits with anything a site puts between them (spaces, dashes, dots, slashes, brackets). */
const spaced = (digits: string) => [...digits].join(BETWEEN_DIGITS);

/**
 * A phone number by its digits alone, however a site groups them (vault-3-x9-5): "+1 555 123 4567" is also
 * "(555) 123-4567" and "+15551234567". Where it was given with its country code ("+…"), also without the code's one
 * to three digits; where with a trunk 0, also without it; and each with a 0 before it ("020 …", "+44 (0)20 …").
 * Fewer than seven digits: only as filled.
 */
function phonePatterns(value: string): RegExp[] {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return [];
  const tails = new Set([digits]);
  if (/^\s*\+/.test(value)) for (let n = 1; n <= 3 && digits.length - n >= 7; n++) tails.add(digits.slice(n));
  else if (digits.startsWith("0") && digits.length > 7) tails.add(digits.slice(1));
  // No digit against it: a longer number is another number.
  return [...tails].map(d => new RegExp(`(?<![0-9])(?:0${BETWEEN_DIGITS})?${spaced(d)}(?![0-9])`, "gu"));
}

/**
 * A card's expiry by its month and year (vault-3-x9-5): "08/29" is also "08/2029", "8/29", "08 - 29" and "2029-08".
 * Never a part of a longer date ("08/29/2026"), which is no expiry and would only say where its digits are. null: not
 * a month and a year (it is then looked for as any other value).
 */
function expiryPatterns(value: string): RegExp[] | null {
  const m = /^(\d{1,2})\s*[/.-]\s*(?:\d{2})?(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const month = `0?${Number(m[1])}`, year = `(?:20)?${m[2]}`, mark = "\\s*[/.\\-]\\s*";
  const alone = (body: string) => new RegExp(`${NONE_BEFORE}(?<!\\d[/.\\-])${body}${NONE_AFTER}(?![/.\\-]\\d)`, "gu");
  return [alone(`${month}${mark}${year}`), alone(`20${m[2]}${mark}${month}`)];
}

interface Noted { value: string; patterns: RegExp[] }

export class VaultRedactor {
  private noted: Noted[] = [];
  private plain = false;
  private filled = false;

  /** A value is about to be put into a field: from now on it is replaced wherever text leaves for a model, the audit or the logs. */
  note(part: VaultPart, value: string): void {
    if (typeof value !== "string" || !value) return;
    this.filled = true;
    if (this.noted.some(n => n.value === value)) return;
    const secret = SECRET_PARTS.has(part);
    // Too short to hide in place: its field is secret, and that is all that keeps it (vault-3-x9-1).
    if (secret && [...value.trim()].length < MIN_SECRET) return;
    // What it can't watch it doesn't take: the caller then fills nothing (VaultService.use), and no value it took
    // earlier is dropped to make room (vault-3-x9-6).
    if (this.noted.length >= MAX_VALUES) throw new Error("the vault's redactor holds as many values as it can watch");
    const alone = !secret;
    const patterns: RegExp[] = [];
    const expiry = part === "expiry" ? expiryPatterns(value) : null;
    // An app may hand an accented letter back composed or in parts: both.
    const forms = new Set([value, value.normalize("NFC"), value.normalize("NFD"), asMarkup(value), asJson(value), ...asAddress(value)]);
    const trimmed = value.trim();
    if (trimmed && trimmed !== value) forms.add(trimmed);
    // An expiry as filled is found by its month and year (above), never inside a longer date.
    if (expiry) for (const form of [value, trimmed]) forms.delete(form);
    for (const form of forms) {
      if (!form) continue;
      // A form no pattern can be made of throws: the caller then fills nothing (VaultService.use), never a value unwatched.
      patterns.push(pattern(form, { fold: !secret, alone }));
    }
    // Then by its digits, whatever stands between them (vault-3-x9-5); after the forms above, which take a "+" with them.
    if (part === "cardNumber" && /^\d{12,}$/.test(value)) patterns.push(new RegExp(spaced(value), "gu"));
    if (part === "phone") patterns.push(...phonePatterns(value));
    if (expiry) patterns.push(...expiry);
    if (!secret) this.plain = true;
    this.noted.push({ value, patterns });
    // Longest first: a value inside another (a user name inside an email) never leaves the rest of the longer one.
    this.noted.sort((a, b) => b.value.length - a.value.length);
  }

  /** Has anything been filled in this run (a value too short to look for included)? While not, every call here returns what it was given. */
  get active(): boolean {
    return this.filled;
  }

  /**
   * Has a part that isn't secret been filled in this run (a user name, an email, an address)? Unlike a password, an
   * app shows such a value as it is, so a picture needs every element read (Perception takes none of a read cut short).
   */
  get shown(): boolean {
    return this.plain;
  }

  /** Does `text` hold a value the vault filled? */
  holds(text: unknown): boolean {
    if (typeof text !== "string" || !text || !this.noted.length) return false;
    for (const n of this.noted) for (const p of n.patterns) { p.lastIndex = 0; if (p.test(text)) { p.lastIndex = 0; return true; } }
    return false;
  }

  /** `text` with every value the vault filled replaced. */
  text(text: string): string {
    if (typeof text !== "string" || !text || !this.noted.length) return text;
    // Marked first and worded last, so no value is ever looked for inside the words that stand for another.
    let out = text;
    for (const n of this.noted) for (const p of n.patterns) { p.lastIndex = 0; out = out.replace(p, MARK); }
    return out === text ? text : out.replace(MARKS, VAULT_REDACTED);
  }

  /**
   * Every string in `value` (in arrays and plain objects, keys too) with the values replaced; anything else as it is.
   * `skip`: a key whose value is left alone (a picture's base64 data, which is pixels, not text). The same object comes
   * back when nothing in it changed.
   */
  deep<T>(value: T, skip?: (key: string, parent: object) => boolean, depth = 0): T {
    if (!this.noted.length) return value;
    if (typeof value === "string") return this.text(value) as unknown as T;
    if (!value || typeof value !== "object" || depth > 12) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map(v => { const r = this.deep(v as unknown, skip, depth + 1); if (r !== v) changed = true; return r; });
      return changed ? out as unknown as T : value;
    }
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value; // a Buffer, a Date, a class instance: not text Ember built
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = this.text(k);
      const r = skip?.(k, value) ? v : this.deep(v, skip, depth + 1);
      if (r !== v || key !== k) changed = true;
      out[key] = r;
    }
    return changed ? out as T : value;
  }
}
