/**
 * The vault as main, the Secure Form and Home all name it (owner decision of 2026-11-12, PLAN.md §2 "Approvals"): the
 * three kinds of entry, their parts, the destination each is bound to, the checks a value must pass, the words the
 * Secure Form shows and the channels. The vault is write-only: a value goes from the Secure Form to main once and is
 * sealed there; nothing here ever carries a value back to a page (VaultEntryRow and VaultFormView hold none). Every
 * word the form shows is built here from the kind and the destination's identity, never from model text or screen
 * text. Pure and renderer-safe.
 */

/** What the vault keeps: a login (user name and password), a card, or contact details. */
export const VAULT_KINDS = ["login", "card", "contact"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

/** Each kind's parts, in the order the form asks for them. */
export const VAULT_PARTS = {
  login: ["user", "password"],
  card: ["cardName", "cardNumber", "expiry", "securityCode"],
  contact: ["name", "email", "phone", "address"],
} as const satisfies Record<VaultKind, readonly string[]>;
export type VaultPart = (typeof VAULT_PARTS)[VaultKind][number];

/** The values of one entry, by part: only what the person typed (a part left empty isn't kept). */
export type VaultValues = Partial<Record<VaultPart, string>>;

/** Which parts are secret (typed into a password input, never shown again in any form). */
export const SECRET_PARTS: ReadonlySet<VaultPart> = new Set<VaultPart>(["password", "cardNumber", "securityCode"]);

/**
 * What a task may ask Ember to fill (the worker's fill_from_vault tool): a name for one part of one kind, and nothing
 * else. Never a value, a label or a destination: Ember reads where the field is itself.
 */
export const VAULT_FILL = {
  "user name": ["login", "user"],
  "password": ["login", "password"],
  "name on card": ["card", "cardName"],
  "card number": ["card", "cardNumber"],
  "card expiry": ["card", "expiry"],
  "card security code": ["card", "securityCode"],
  "full name": ["contact", "name"],
  "email": ["contact", "email"],
  "phone": ["contact", "phone"],
  "address": ["contact", "address"],
} as const satisfies Record<string, readonly [VaultKind, VaultPart]>;
export type VaultWhat = keyof typeof VAULT_FILL;
/** The names the tool takes, in the order above. */
export const VAULT_WHATS = Object.keys(VAULT_FILL) as [VaultWhat, ...VaultWhat[]];

const PART_SAVED: Readonly<Record<VaultPart, string>> = {
  user: "a saved user name", password: "a saved password", cardName: "a saved name on a card", cardNumber: "a saved card number",
  expiry: "a saved card expiry date", securityCode: "a saved card security code", name: "a saved name", email: "a saved email address",
  phone: "a saved phone number", address: "a saved address",
};
/** A part as a fill is announced and listed ("a saved password"): the kind of thing only, never a value or its length. */
export const savedPart = (part: VaultPart): string => PART_SAVED[part];

/** Each part's label in the form, and how it is checked (`max` characters; `required` for that kind). */
export const PART_SPEC: Readonly<Record<VaultPart, { label: string; max: number; required: boolean; multiline?: true }>> = {
  user: { label: "User name or email", max: 256, required: false },
  password: { label: "Password", max: 1024, required: true },
  cardName: { label: "Name on the card", max: 200, required: false },
  cardNumber: { label: "Card number", max: 23, required: true },
  expiry: { label: "Expiry date (MM/YY)", max: 7, required: true },
  securityCode: { label: "Security code", max: 4, required: true },
  name: { label: "Full name", max: 200, required: false },
  email: { label: "Email", max: 254, required: false },
  phone: { label: "Phone", max: 40, required: false },
  address: { label: "Address", max: 500, required: false, multiline: true },
};

/**
 * Where an entry may be filled: one app, by the identity policy uses for it (its program name, folded: vaultAppKey),
 * or one site, by its origin (scheme, host and port: siteOrigin), whatever browser shows it. Never both.
 */
export type VaultDestination = { app: string } | { site: string };

/** At most this many entries are kept. */
export const VAULT_MAX_ENTRIES = 200;

/** Characters that show nothing (format characters, blank letters) and marks that ride on a letter, which would make one app's name look like another's. */
const INVISIBLE = /\p{Cf}|\p{Mn}|[ᅟᅠ⠀ㅤﾠ]/gu;

/**
 * An app's identity as an entry is bound to it: its program name as the window system reports it (WM_CLASS, the
 * process's name, the app's name), folded so the same program always gives the same key ("Firefox", "firefox.desktop"
 * and "firefox.exe" are one; characters that show nothing are dropped, so a name can't differ from another only by
 * those), or null when nothing is left to bind to or it is no program's name (a path, a control character).
 */
export function vaultAppKey(app: string): string | null {
  // A control character (a tab, a line break) is in no program's name: nothing to bind to.
  if (typeof app !== "string" || app.length > 200 || /\p{Cc}/u.test(app)) return null;
  const key = app.normalize("NFKC").replace(INVISIBLE, "").trim().toLowerCase().replace(/\.(desktop|exe)$/, "").trim();
  return key && key.length <= 100 && !/[\s:/\\]/.test(key.replace(/ /g, "")) ? key : null;
}

/**
 * A page's origin as an entry is bound to it, from the address Ember itself read from the browser (never from the
 * page's words or a model): "https://github.com", "http://intranet:8080". Only http and https, with a host; the host as
 * the URL parser gives it (lower case, an international name in its xn-- form, so a look-alike never matches the real
 * one); the port only where it isn't the scheme's own. Null for anything else (a file, a data URL, user:pass@ in it).
 */
export function siteOrigin(address: string): string | null {
  if (typeof address !== "string" || !address || address.length > 4096) return null;
  let u: URL;
  try { u = new URL(address); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname || u.username || u.password) return null;
  return u.origin;
}

/** A destination well formed: an app key or an origin exactly as vaultAppKey and siteOrigin give them. */
export function validDestination(d: unknown): d is VaultDestination {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return false;
  const o = d as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 1) return false;
  if (keys[0] === "app") return typeof o.app === "string" && vaultAppKey(o.app) === o.app;
  if (keys[0] === "site") return typeof o.site === "string" && siteOrigin(o.site) === o.site;
  return false;
}

/** The same destination: the same app key, or the same origin. */
export const sameDestination = (a: VaultDestination, b: VaultDestination): boolean =>
  "app" in a ? "app" in b && a.app === b.app : "site" in b && a.site === b.site;

/** A site as people read it: the host for https on its own port ("github.com"), else the whole origin. */
export function siteLabel(origin: string): string {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" && !u.port ? u.hostname : u.origin;
  } catch {
    return origin;
  }
}

/** One entry as Home lists it: its kind, where it is for and when it was saved. Never a value, nor its length. */
export interface VaultEntryRow {
  id: string;
  kind: VaultKind;
  /** "github.com", or the app's familiar name ("Thunderbird"): built by main, never from a model. */
  where: string;
  /** Whether it is for a site (else an app). */
  site: boolean;
  /** When it was saved (ms since the epoch). */
  savedAt: number;
}

/**
 * The vault as Home shows it. `allowed`: the organisation lets it be used (`features.vault`; a lockdown turns it off).
 * The keyring isn't asked for Home (on macOS asking can prompt): the Secure Form says so when one is needed.
 */
export interface VaultHomeState { allowed: boolean; entries: VaultEntryRow[] }

/**
 * What the Secure Form shows: built by main from the kind and the destination's identity (and, for a site, the browser
 * the form was asked from). `keyring` false: this computer can't keep it safely, so the form says so and keeps nothing.
 */
export interface VaultFormView {
  id: string;
  kind: VaultKind;
  title: string;
  where: string;
  lead: string;
  parts: { part: VaultPart; label: string; secret: boolean; required: boolean; max: number; multiline: boolean }[];
  keyring: boolean;
}

/** What a Save came to, said by the form (never with a value). */
export type VaultSubmitResult = { ok: true } | { ok: false; why: VaultSaveProblem; part?: VaultPart };
/** Why a Save kept nothing: a value that can't be kept, no keyring, the file, a full vault, or a form main closed. */
export type VaultSaveProblem = "invalid" | "keyring" | "write" | "full" | "gone";

/** The form's channels (its own preload) and Home's (the settings window's preload). */
export const VAULT_IPC = {
  /** The form's page asks for what to show (VaultFormView), or null with none (each form has a window of its own). */
  form: "vault:form",
  /** Save: the form's id and its values, once. */
  submit: "vault:submit",
  /** Cancel, Esc or Close: nothing is kept. */
  cancel: "vault:cancel",
  /** Home: the vault's state (VaultHomeState). */
  list: "vault:list",
  /** Home: main says the list changed. */
  changed: "vault:changed",
  /** Home: forget one entry by its id. */
  forget: "vault:forget",
  /** Home: forget every entry. */
  forgetAll: "vault:forget-all",
} as const;

const KIND_TITLE: Readonly<Record<VaultKind, string>> = { login: "Login", card: "Card", contact: "Contact details" };
/** A kind as Home's rows and the form's title name it. */
export const kindName = (k: VaultKind): string => KIND_TITLE[k];

/**
 * The form's title and its line saying where the details are for, from the kind and the destination alone: "Login for
 * github.com" and "Asked in Firefox. Ember fills it in only on github.com, in any browser." `site`: the destination is a
 * site (else an app); `via`: the browser's familiar name, for a site (main's, from the window system, never a model's).
 */
export function formWords(kind: VaultKind, where: string, site: boolean, via: string | null): { title: string; where: string; lead: string } {
  const them = kind === "contact" ? "them" : "it";
  return {
    title: `${KIND_TITLE[kind]} for ${where}`,
    where: site
      ? `${via ? `Asked in ${via}. ` : ""}Ember fills ${them} in only on ${where}, in any browser.`
      : `Ember fills ${them} in only in ${where}.`,
    lead: `Ember keeps ${them} locked with your computer's keyring and uses ${them} only in Autopilot. It never shows ${them} to you again, and the AI model never sees ${them}.`,
  };
}

/** The form's words when the computer has no keyring for passwords: nothing can be kept. */
export const VAULT_NO_KEYRING = "The vault can't be used on this computer: there is no keyring to lock it with, so what you type would be saved as plain text. Nothing is saved.";

const DIGITS = /^\d+$/;
/** A card number's digits: 12 to 19, with spaces or dashes between groups allowed; null when it isn't one. */
export function cardDigits(v: string): string | null {
  const d = v.replace(/[ -]/g, "");
  return DIGITS.test(d) && d.length >= 12 && d.length <= 19 ? d : null;
}
/** An expiry as MM/YY or MM/YYYY (a month 01–12); null when it isn't one. */
export function expiryOf(v: string): string | null {
  const m = /^\s*(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})\s*$/.exec(v);
  return m ? `${m[1]}/${m[2].slice(-2)}` : null;
}

/**
 * Why a part's value can't be kept, or null when it can: too long, a line break where there is no room for one, a
 * character that can't be typed (NUL and other controls), or a card's number, expiry or code that isn't one. The page
 * and main both check with this; main's check is the one that counts.
 */
export function partProblem(part: VaultPart, v: string): "long" | "format" | null {
  const spec = PART_SPEC[part];
  if (v.length > spec.max) return "long";
  // eslint-disable-next-line no-control-regex -- the controls a field can't take are exactly what this finds
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v) || (!spec.multiline && /[\r\n\t]/.test(v))) return "format";
  if (part === "cardNumber" && cardDigits(v) === null) return "format";
  if (part === "expiry" && expiryOf(v) === null) return "format";
  if (part === "securityCode" && !/^\d{3,4}$/.test(v)) return "format";
  if (part === "email" && v && !/^[^\s@]+@[^\s@]+$/.test(v)) return "format";
  return null;
}

/**
 * One entry's values checked whole: an object with only `kind`'s parts, each a string, each required one there and
 * every one passing partProblem; contact details need at least one part. Returns the values to keep (empty parts
 * dropped, a card's number as digits and its expiry as MM/YY) or the first part that fails. Never echoes a value.
 */
export function checkValues(kind: VaultKind, raw: unknown): { ok: true; values: VaultValues } | { ok: false; part?: VaultPart } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const o = raw as Record<string, unknown>;
  const parts: readonly VaultPart[] = VAULT_PARTS[kind];
  if (Object.keys(o).some(k => !(parts as readonly string[]).includes(k))) return { ok: false };
  const values: VaultValues = {};
  for (const part of parts) {
    const v = o[part];
    if (v !== undefined && typeof v !== "string") return { ok: false, part };
    const text = (v ?? "") as string;
    // A secret is kept exactly as typed; other parts without the spaces around them.
    const kept = SECRET_PARTS.has(part) && part !== "cardNumber" ? text : text.trim();
    if (!kept) {
      if (PART_SPEC[part].required) return { ok: false, part };
      continue;
    }
    if (partProblem(part, kept)) return { ok: false, part };
    values[part] = part === "cardNumber" ? cardDigits(kept) ?? kept : part === "expiry" ? expiryOf(kept) ?? kept : kept;
  }
  if (!Object.keys(values).length) return { ok: false };
  return { ok: true, values };
}

/** What the form says under a part that can't be kept. */
export function partProblemText(part: VaultPart): string {
  switch (part) {
    case "password": return "Type the password.";
    case "cardNumber": return "Type the card's number: 12 to 19 digits.";
    case "expiry": return "Type the expiry date as MM/YY, for example 08/29.";
    case "securityCode": return "Type the 3 or 4 digits of the security code.";
    case "email": return "Type an email address, or leave it empty.";
    default: return `This is too long or has a character Ember can't type. Shorten it or leave it empty.`;
  }
}

/** The form's buttons. */
export const VAULT_FORM_BUTTONS = { save: "Save in the vault", cancel: "Cancel", close: "Close" } as const;
/** Under the fields while a Save is being kept. */
export const VAULT_SAVING = "Saving…";
/** What the form says when a Save didn't keep anything, by why (never with a value). */
export function vaultSaveProblem(why: VaultSaveProblem): string {
  switch (why) {
    case "full": return `The vault is full: it keeps ${VAULT_MAX_ENTRIES} entries at most. Forget one you no longer need in Settings, under Apps & privacy, then try again.`;
    case "keyring": return VAULT_NO_KEYRING;
    case "write": return "Ember couldn't save this in its data folder, so nothing is kept. Check that the disk isn't full, then try again.";
    case "gone": return "Ember closed this request, so nothing is kept. Close this window.";
    default: return "Something here can't be kept as it is. Check each box and try again.";
  }
}
/** On a form whose window hasn't the keyboard: typing would go to another app (as the prompt window says it). */
export const VAULT_KEYBOARD_ELSEWHERE = "Click here before you type: the keyboard is still in another app.";
/** How long the form's window may take to get the keyboard before the page says it hasn't. */
export const VAULT_FOCUS_GRACE_MS = 600;
/** A part's label as the form shows it: one that may be left empty says so. */
export const partLabel = (label: string, required: boolean): string => (required ? label : `${label} (optional)`);
/** Save pressed with every box empty. */
export const VAULT_NOTHING_TYPED = "Nothing is typed yet. Fill in at least one box, or choose Cancel.";

/** Home's bridge to the vault (app/preload/home.ts exposes exactly this as `window.emberVault`): the list and Forget, never a value. */
export interface EmberVaultHomeApi {
  /** Whether the vault may be used, and its entries by kind, destination and date. */
  state(): Promise<VaultHomeState>;
  /** The list changed (an entry kept or forgotten). */
  onChanged(fn: () => void): () => void;
  /** Forgets one entry; false when it couldn't be removed. */
  forget(id: string): Promise<boolean>;
  /** Forgets every entry; false when the vault's file couldn't be removed. */
  forgetAll(): Promise<boolean>;
}
