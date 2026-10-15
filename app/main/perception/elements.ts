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

/** The label beside an unnamed control: on its row to its left, else just above it and starting where it starts. */
function labelFor(b: Bounds, labels: AxNode[]): string | null {
  const cy = b.y + b.height / 2;
  let left: { name: string; gap: number } | null = null, above: { name: string; gap: number } | null = null;
  for (const l of labels) {
    const lb = l.bounds!;
    const gap = b.x - (lb.x + lb.width);
    if (Math.abs(lb.y + lb.height / 2 - cy) < Math.max(12, b.height / 2) && gap >= -4 && gap < 320 && (!left || gap < left.gap)) left = { name: l.name, gap };
    const up = b.y - (lb.y + lb.height);
    if (up >= -4 && up < 24 && Math.abs(lb.x - b.x) <= 16 && (!above || up < above.gap)) above = { name: l.name, gap: up };
  }
  return left?.name ?? above?.name ?? null;
}

export function inferLabels(nodes: AxNode[]): Map<number, string> {
  const labels = nodes.filter(n => LABEL_ROLES.has(n.role) && n.name && n.bounds);
  const out = new Map<number, string>();
  for (const n of nodes) {
    if (n.name || !n.bounds || !INTERACTIVE.has(n.role)) continue;
    const name = labelFor(n.bounds, labels);
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
 * alike, matched on lowercase, NFKC-normalised text.
 */
export const SECRET_WORDS = [
  // Passwords and PINs.
  "pass(word|phrase|code|wd)", "passwort", "kennwort", "passord", "wachtwoord", "mot de passe", "contrase(n|ñ)a", "senha",
  "palavra-passe", "parola", "parolă", "clave", "lösenord", "adgangskode", "salasana", "hasło", "heslo", "geslo", "lozinka",
  "jelszó", "(ş|s)ifre", "κωδικός", "пароль", "лозинка", "kata sandi", "mật khẩu", "كلمة (المرور|السر)", "pin( ?code)?",
  // Cards and bank accounts.
  "card ?(number|no)", "credit ?card", "cvv2?", "cvc2?", "csc", "security code", "card verification", "expir(y|ation)",
  "kartennummer", "kreditkarte(nnummer)?", "prüfziffer", "prüfnummer", "sicherheitscode", "ablaufdatum", "num(é|e)ro de (la )?carte",
  "cryptogramme", "date d['’]expiration", "n(ú|u)mero de (la )?tarjeta", "n(ú|u)mero do cart(ã|a)o", "numero (di|della) carta",
  "kaartnummer", "kortnummer", "numer karty", "номер карты", "c(ó|o)digo de (seguridad|segurança|verificaci(ó|o)n|verificação|acceso|confirmaci(ó|o)n)",
  "codice di (sicurezza|verifica)", "fecha de (caducidad|vencimiento|expiraci(ó|o)n)", "iban", "routing number", "account number",
  "sort code", "kontonummer",
  // One-time codes.
  "one[- ]time (code|password|pin)", "otp", "2fa", "two[- ]factor", "totp", "verification code", "auth(entication)? code",
  "recovery (code|key)", "bestätigungscode", "code de (vérification|sécurité|confirmation)", "verificatiecode", "kod weryfikacyjny",
  "код (подтверждения|безопасности)",
  // Keys, network passwords and secret answers.
  "secret", "private key", "(api|access|auth|bearer) ?(key|token)", "wi-?fi (key|password|passphrase)", "network (security )?key",
  "wpa2? ?(key|passphrase)", "pre-?shared key", "psk", "encryption key", "security (answer|question)", "secret (answer|question)",
  "ssn", "social security",
];
/** The same, for scripts written without spaces between words (matched anywhere in the label). */
export const SECRET_ANYWHERE = ["密码", "密碼", "口令", "パスワード", "暗証", "비밀번호", "암호", "รหัสผ่าน", "סיסמ", "卡号", "卡號", "カード番号",
  "安全码", "安全碼", "验证码", "驗證碼", "確認コード", "セキュリティコード", "認証コード"];

const SECRET_LABEL = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${SECRET_WORDS.join("|")})(?![\\p{L}\\p{N}_])|${SECRET_ANYWHERE.join("|")}`, "u");

/** Lowercase NFKC text without invisible characters (and Turkish İ's stray dot), as labels are matched. */
const normalize = (s: string) => s.normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase().replace(/\u0307/g, "");

/** Does this field name or label say its contents are secret? */
export const isSecretLabel = (label: string) => !!label && SECRET_LABEL.test(normalize(label));

/** Input fields, whose label can make their contents secret (documents and terminals are not judged by name). */
const FIELD_ROLES = new Set(["text", "entry", "password text", "spin button", "combo box"]);

/** Is this element's text off limits (a password field, or a field labelled as secret)? */
export function isSecretNode(n: Pick<AxNode, "role" | "name"> & { secret?: boolean }, label = ""): boolean {
  return !!n.secret || n.role === "password text" || (FIELD_ROLES.has(n.role) && (isSecretLabel(n.name) || isSecretLabel(label)));
}

/** "Show", "Reveal", "Hide password", "Passwort anzeigen": a control that shows (or hides again) a password. */
const REVEAL = /(^|[^\p{L}])(show|reveal|unmask|hide|visibility|anzeigen|einblenden|ausblenden|afficher|masquer|mostrar|ocultar|mostra|nascondi|toon|verbergen|visa|dölj|näytä|piilota|pokaż|ukryj|zobrazit|skrýt|göster|gizle|показать|скрыть)([^\p{L}]|$)|显示|顯示|隐藏|表示/u;
const REVEAL_ROLES = new Set(["check box", "toggle button", "switch", "push button", "check menu item"]);
const isRevealControl = (n: AxNode) => {
  const name = normalize(n.name).trim();
  return REVEAL_ROLES.has(n.role) && REVEAL.test(name) && (isSecretLabel(name) || !/\s/.test(name));
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
 * (by the label to their left or above them), and fields with a "Show password" or "Reveal"
 * control beside them, which hold a password even after it was revealed.
 */
export function secretIds(nodes: AxNode[], labels = inferLabels(nodes)): Set<number> {
  const out = new Set<number>();
  const reveals = nodes.filter(n => n.bounds && isRevealControl(n));
  for (const n of nodes) {
    if (isSecretNode(n, labels.get(n.id) ?? "")) out.add(n.id);
    else if (FIELD_ROLES.has(n.role) && n.bounds && reveals.some(r => besideField(n.bounds!, r.bounds!))) out.add(n.id);
  }
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

export function serializeElements(window: AxWindow, nodes: AxNode[], opts: SerializeOptions = {}): string {
  const maxLines = opts.maxLines ?? 150;
  const labels = inferLabels(nodes);
  const minDepth = Math.min(...nodes.map(n => n.depth), 0);
  const lines: string[] = [];
  for (const n of nodes) {
    if (lines.length >= maxLines) { lines.push(`… ${nodes.length - maxLines} more elements not shown`); break; }
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
    lines.push("  ".repeat(Math.max(0, n.depth - minDepth)) + bits.join(" "));
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
