/**
 * Turns an accessibility snapshot into compact text for the model. Unnamed
 * controls borrow the label to their left, or just above them (GTK switches
 * have no name of their own). Everything read from the screen is wrapped as
 * untrusted data.
 */

import type { AxNode, AxWindow, Bounds } from "./sidecar";

const INTERACTIVE = new Set(["push button", "toggle button", "check box", "radio button", "combo box", "text", "entry",
  "password text", "spin button", "slider", "menu item", "menu", "link", "page tab", "list item", "table cell", "check menu item",
  "radio menu item", "tree item", "switch", "icon"]);

/** Text that labels a control: GTK's and Qt's labels, Chromium's plain text. Keep in step with LABEL_ROLES in ember_atspi.py. */
const LABEL_ROLES = new Set(["label", "static", "caption"]);
/** Input fields, whose label can make their contents secret (documents and terminals are not judged by name). */
const FIELD_ROLES = new Set(["text", "entry", "password text", "spin button", "combo box"]);
/**
 * Controls a label on their row names (a label beside a link or a button is usually a heading).
 * Keep in step with LABELLED_ROLES in ember_atspi.py.
 */
const NAMED_BY_ROW = new Set([...FIELD_ROLES, "check box", "radio button", "toggle button", "switch", "slider"]);

/** The gap between a label and the control to its right on the same row, or null when it isn't there. */
function beside(lb: Bounds, b: Bounds): number | null {
  const gap = b.x - (lb.x + lb.width);
  const sameRow = Math.abs(lb.y + lb.height / 2 - (b.y + b.height / 2)) < Math.max(12, b.height / 2);
  return sameRow && gap >= -4 && gap < 320 ? gap : null;
}

/** Reads like a label, not a paragraph: short, one line, no sentence ending before more text. */
const labelLike = (s: string) => s.length <= 40 && !/[\n\r]/.test(s) && !/[.!?]\s+\S/.test(s);

/**
 * The label beside an unnamed control: on its row to its left, else just above it and over its left
 * part (from a little left of where it starts, for an indented field, to no further than its middle).
 * A label that already names a control on its own row (`claimed`) names nothing below it. Text above
 * names it only when it reads like a label (a paragraph over a text area is the page, not its name),
 * unless `anyAbove` (secret detection: "Enter the password for your account at …" still counts).
 */
function labelFor(b: Bounds, labels: AxNode[], claimed: Set<number>, anyAbove = false): string | null {
  let left: { name: string; gap: number } | null = null, above: { name: string; gap: number } | null = null;
  for (const l of labels) {
    const lb = l.bounds!;
    const gap = beside(lb, b);
    if (gap !== null && (!left || gap < left.gap)) left = { name: l.name, gap };
    const up = b.y - (lb.y + lb.height);
    if (up >= -4 && up < 24 && lb.x <= b.x + b.width / 2 && lb.x + lb.width >= b.x - 16 && !claimed.has(l.id) && (anyAbove || labelLike(l.name)) && (!above || up < above.gap)) above = { name: l.name, gap: up };
  }
  return left?.name ?? above?.name ?? null;
}

/** `anyAbove`: any text just above an unnamed control names it, sentences too (for secret detection only). */
export function inferLabels(nodes: AxNode[], { anyAbove = false } = {}): Map<number, string> {
  const labels = nodes.filter(n => LABEL_ROLES.has(n.role) && n.name && n.bounds);
  const controls = nodes.filter(n => NAMED_BY_ROW.has(n.role) && n.bounds);
  const claimed = new Set(labels.filter(l => controls.some(c => beside(l.bounds!, c.bounds!) !== null)).map(l => l.id));
  const out = new Map<number, string>();
  for (const n of nodes) {
    if (n.name || !n.bounds || !INTERACTIVE.has(n.role)) continue;
    const name = labelFor(n.bounds, labels, claimed, anyAbove);
    if (name) out.set(n.id, name);
  }
  return out;
}

/**
 * Labels of fields whose contents never reach the model: passwords, payment and
 * bank details, one-time codes, keys, in the languages Ember's users are likely
 * to meet. The sidecar withholds these already (SECRET_WORDS and SECRET_ANYWHERE
 * in ember_atspi.py: the same lists, a unit test checks); this is the second line.
 * Each entry is a regular expression both Python's and JavaScript's engines read
 * alike, matched on lowercase, NFKC-normalised text, as whole words (English
 * ones in the plural too: "Recovery codes").
 */
export const SECRET_WORDS = [
  // Passwords and PINs. Words that mean something else too stand alone or in a phrase that says password
  // ("Palabras clave" are keywords, a "Parola chiave" a keyword).
  "pass(word|phrase|code|wd)s?", "passwort", "kennwort", "passord", "wachtwoord", "mot de passe", "contrase(n|ñ)a",
  "contrasenya", "senha", "palavra-passe", "^[\\s:*]*parol(a|ă)[\\s:*]*$", "parolă", "parola d['’]ordine",
  "parola (nou(a|ă)|actual(a|ă)|curent(a|ă)|veche|contului)", "(confirm(a|ă)|introduce(ți|ti)|schimb(a|ă)) parola",
  "(yeni|mevcut|eski) parola", "parola(nız|yı|nızı)", "парола", "^[\\s:*]*clave[\\s:*]*$",
  "clave (de acceso|secreta|personal|bancaria|de seguridad|de (la )?tarjeta)", "(tu|su) clave", "lösenord", "adgangskode",
  "salasana", "hasło", "heslo", "geslo", "lozinka", "jelszó", "(ş|s)ifre", "κωδικός", "пароль", "лозинка", "kata sandi",
  "mật khẩu", "كلمة (المرور|السر)", "pin( ?code)?s?",
  // Cards and bank accounts. An expiry date only beside a card ("Expiration date of the report" is not one).
  "card ?(number|no)s?", "credit ?cards?", "cvv2?", "cvc2?", "csc", "security codes?", "card verification",
  "card (expir(y|ation)|exp)", "mm ?/ ?(yy|aa|jj){1,2}", "valid (thru|through)", "kartennummer", "kreditkarte(nnummer)?",
  "prüfziffer", "prüfnummer", "sicherheitscode", "ablaufdatum der karte", "num(é|e)ro de (la )?carte", "cryptogramme",
  "date d['’]expiration de (la )?carte", "n(ú|u)mero de (la )?tarjeta", "n(ú|u)mero do cart(ã|a)o", "numero (di|della) carta",
  "kaartnummer", "kortnummer", "numer karty", "номер карты",
  "c(ó|o)digo de (seguridad|segurança|verificaci(ó|o)n|verificação|acceso|confirmaci(ó|o)n)",
  "codice di (sicurezza|verifica)", "(fecha de )?(caducidad|vencimiento|expiraci(ó|o)n) de (la )?tarjeta", "ibans?",
  "routing numbers?", "account numbers?", "sort codes?", "kontonummer",
  // One-time codes.
  "one[- ]time (code|password|pin)s?", "otps?", "2fa", "two[- ]factor", "totp", "verification codes?", "auth(entication)? codes?",
  "recovery (code|key)s?", "backup codes?", "bestätigungscode", "code de (vérification|sécurité|confirmation)", "verificatiecode", "kod weryfikacyjny",
  "код (подтверждения|безопасности)",
  // Keys, network passwords and secret answers.
  "secrets?", "private keys?", "(api|access|auth|bearer) ?(key|token)s?", "wi-?fi (key|password|passphrase)s?", "network (security )?keys?",
  "wpa2? ?(key|passphrase)s?", "pre-?shared keys?", "psk", "encryption keys?", "security (answer|question)s?", "secret (answer|question)s?",
  "ssns?", "social security",
];
/** The same, for scripts written without spaces between words (matched anywhere in the label). */
export const SECRET_ANYWHERE = ["密码", "密碼", "口令", "パスワード", "暗証", "비밀번호", "암호", "รหัสผ่าน", "סיסמ", "卡号", "卡號", "カード番号",
  "安全码", "安全碼", "验证码", "驗證碼", "確認コード", "セキュリティコード", "認証コード"];

const SECRET_LABEL = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${SECRET_WORDS.join("|")})(?![\\p{L}\\p{N}_])|${SECRET_ANYWHERE.join("|")}`, "u");

/** Lowercase NFKC text without invisible characters (and Turkish İ's stray dot), as labels are matched. */
const normalize = (s: string) => s.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(/\u0307/g, "");

/** Does this field name or label say its contents are secret? */
export const isSecretLabel = (label: string) => !!label && SECRET_LABEL.test(normalize(label));

/** Is this element's text off limits (a password field, or a field labelled as secret)? */
export function isSecretNode(n: Pick<AxNode, "role" | "name"> & { secret?: boolean }, label = ""): boolean {
  return !!n.secret || n.role === "password text" || (FIELD_ROLES.has(n.role) && (isSecretLabel(n.name) || isSecretLabel(label)));
}

/** "Show", "Reveal", "Hide password", "Passwort anzeigen": a control that shows (or hides again) a password. */
const REVEAL = /(^|[^\p{L}])(show|reveal|unmask|hide|visibility|anzeigen|einblenden|ausblenden|afficher|masquer|mostrar|ocultar|mostra|nascondi|toon|verbergen|visa|dölj|näytä|piilota|pokaż|ukryj|zobrazit|skrýt|göster|gizle|показать|скрыть)([^\p{L}]|$)|显示|顯示|隐藏|表示/u;
const REVEAL_ROLES = new Set(["check box", "toggle button", "switch", "push button", "check menu item"]);
/**
 * Fields a bare "Show" or "Reveal" beside them is about: keys, codes and PINs (a password revealed before
 * Ember looked). A "Show" beside a search or filter field ("Anzeigen", "Afficher") shows results, not a password.
 */
const KEYISH = /(^|[^\p{L}])(key|code|pin|passphrase|token|schlüssel|clé|cle|chiave|llave|sleutel|nyckel|nøgle|nøkkel|klucz|ключ|код)([^\p{L}]|$)/u;
/** A reveal toggle, and whether it names a password itself ("Show password") or is a bare word ("Show"). */
const revealKind = (n: AxNode): "password" | "bare" | null => {
  if (!REVEAL_ROLES.has(n.role)) return null;
  const name = normalize(n.name).trim();
  if (!REVEAL.test(name)) return null;
  return isSecretLabel(name) ? "password" : /\s/.test(name) ? null : "bare";
};

/** Is control `c` where a field's reveal toggle goes: on its row from its middle to a little past it, or just below it? */
function besideField(f: Bounds, c: Bounds): boolean {
  const row = Math.abs(f.y + f.height / 2 - (c.y + c.height / 2)) < Math.max(12, f.height / 2);
  if (row && c.x >= f.x + f.width / 2 && c.x - (f.x + f.width) < 160) return true;
  const below = c.y - (f.y + f.height);
  return below >= -4 && below < 40 && c.x >= f.x - 16 && c.x < f.x + f.width;
}

/**
 * Elements whose contents are secret: password fields, fields named or labelled as secret
 * (by the label to their left or above them), and fields beside a "Show password" toggle, or
 * a bare "Show" or "Reveal" when the field is named like a key or code: they hold a password
 * even after it was revealed.
 */
export function secretIds(nodes: AxNode[], labels = inferLabels(nodes, { anyAbove: true })): Set<number> {
  const out = new Set<number>();
  const reveals = nodes.flatMap(n => { const kind = n.bounds ? revealKind(n) : null; return kind ? [{ b: n.bounds!, kind }] : []; });
  for (const n of nodes) {
    const label = labels.get(n.id) ?? "";
    if (isSecretNode(n, label)) { out.add(n.id); continue; }
    if (!FIELD_ROLES.has(n.role) || !n.bounds) continue;
    const keyish = KEYISH.test(normalize(n.name || label));
    if (reveals.some(r => (r.kind === "password" || keyish) && besideField(n.bounds!, r.b))) out.add(n.id);
  }
  return out;
}

/**
 * Elements inside the secret fields `secret` (ids): what they hold, which Chromium lists as static text
 * inside a text box. A read lists parents before their children.
 */
export function insideSecrets(nodes: AxNode[], secret: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const n of nodes) if (n.parent !== null && (secret.has(n.parent) || out.has(n.parent))) out.add(n.id);
  return out;
}

/** JSON-quoted and truncated; "<" is escaped so screen text can't close the <screen> wrapper. */
const quote = (s: string, max: number) => JSON.stringify(s.length > max ? s.slice(0, max) + "…" : s).replace(/</g, "\\u003c");
/** The same quoting for screen text that reaches the model anywhere else (titles, names, values). */
export const quoteUntrusted = (s: string, max = 120) => quote(s, max);
/**
 * Role and action names, bare when they are plain words ("push button", "click"), quoted otherwise:
 * an app can make up its own role and action names, so they are screen text too.
 */
export const screenWord = (s: string) => /^[a-z][a-z0-9 _-]{0,39}$/i.test(s) ? s : quote(s, 40);

export interface SerializeOptions {
  maxLines?: number;
  maxTextChars?: number;
  /** Include bounds (for workers that click by element). */
  withBounds?: boolean;
  /** Lines put first inside the wrapper (they must quote any screen text themselves, with quoteUntrusted). */
  header?: string[];
}

/** Rows and cells: many of them in a list, each one item of content rather than a control. */
const ITEM_ROLES = new Set(["list item", "table cell", "tree item", "icon"]);

/**
 * How much an element says, for choosing what to list when there are too many: controls (3),
 * then rows and cells (2), then text and anything named (1), then unnamed containers (0).
 */
function weight(n: AxNode, labels: Map<number, string>): number {
  if (INTERACTIVE.has(n.role) && !ITEM_ROLES.has(n.role)) return 3;
  if (ITEM_ROLES.has(n.role) && (n.name || n.text)) return 2;
  return n.name || n.text || labels.has(n.id) || n.value !== undefined ? 1 : 0;
}

export function serializeElements(window: AxWindow, read: AxNode[], opts: SerializeOptions = {}): string {
  const maxLines = opts.maxLines ?? 150;
  // What secret fields hold is never listed, whatever the sidecar sent (nor does it label anything).
  const readLabels = inferLabels(read);
  const inside = insideSecrets(read, new Set(read.filter(n => isSecretNode(n, n.name || readLabels.get(n.id) || "")).map(n => n.id)));
  const nodes = inside.size ? read.filter(n => !inside.has(n.id)) : read;
  const labels = inside.size ? inferLabels(nodes) : readLabels;
  // Indented by the elements listed above it: a web page's unnamed layers of <div>s add nothing.
  const level = new Map<number, number>();
  for (const n of nodes) level.set(n.id, n.parent !== null && level.has(n.parent) ? level.get(n.parent)! + 1 : 0);
  // Too many to list: what says least is left out first (unnamed containers, then text, then rows), in tree order.
  let shown: Set<number> | null = null;
  if (nodes.length > maxLines) {
    const order = nodes.map((n, i) => ({ i, w: weight(n, labels) })).sort((a, b) => b.w - a.w || a.i - b.i);
    shown = new Set(order.slice(0, maxLines).map(o => nodes[o.i].id));
  }
  const lines: string[] = [];
  const left = [0, 0, 0, 0];
  for (const n of nodes) {
    if (shown && !shown.has(n.id)) { left[weight(n, labels)]++; continue; }
    const name = n.name || labels.get(n.id) || "";
    const bits = [`[${n.id}] ${screenWord(n.role)}`];
    if (name) bits.push(quote(name, 80) + (n.name ? "" : " (label)"));
    const states = n.states.filter(s => !["enabled", "sensitive", "focusable"].includes(s));
    if (!n.states.includes("sensitive") && !n.states.includes("enabled")) states.push("disabled");
    // Contents of password and payment fields are never shown, whatever the sidecar sent.
    const secret = isSecretNode(n, name);
    if (secret) states.push("secret");
    if (states.length) bits.push(`(${states.join(", ")})`);
    if (n.value !== undefined && !secret) bits.push(`value=${n.value}`);
    if (n.actions?.length) bits.push(`actions=${n.actions.map(screenWord).join("/")}`);
    if (n.text && !secret) bits.push(`text=${quote(n.text, opts.maxTextChars ?? 160)}`);
    if (n.selection && !secret) bits.push(`selected=${quote(n.selection, 300)}`);
    if (opts.withBounds && n.bounds) bits.push(`@${n.bounds.x},${n.bounds.y} ${n.bounds.width}x${n.bounds.height}`);
    lines.push("  ".repeat(level.get(n.id)!) + bits.join(" "));
  }
  if (shown) {
    const kinds = [[left[0], "without a name"], [left[1], "text"], [left[2], "rows or cells"], [left[3], "controls"]] as const;
    const what = kinds.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
    lines.push(`… ${nodes.length - shown.size} more elements not shown (${what}${left[3] ? "" : "; every control is listed"})`);
  }
  const attrs = `app=${quote(window.app, 60)} window=${quote(window.name, 100)}`;
  return `<screen source="accessibility" ${attrs} untrusted="true">\n${[...opts.header ?? [], ...lines].join("\n")}\n</screen>`;
}

export function focusedElement(nodes: AxNode[]): AxNode | null {
  return nodes.find(n => n.states.includes("focused")) ?? null;
}

/** True when the app or window matches the user's "never look at" list. */
export function isNeverLook(window: { app: string; name: string }, list: string[]): boolean {
  const hay = `${window.app} ${window.name}`.toLowerCase();
  return list.some(item => item.trim() && hay.includes(item.trim().toLowerCase()));
}
