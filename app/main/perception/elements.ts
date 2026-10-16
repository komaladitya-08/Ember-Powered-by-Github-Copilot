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

/**
 * A combo box named after the option it shows (GTK names one so): that name is its value, not its label, so it is
 * labelled as an unnamed control is. Keep in step with named_by_value in ember_atspi.py.
 */
export const namedByValue = (n: Pick<AxNode, "role" | "name" | "selected" | "text">) =>
  n.role === "combo box" && !!n.name && (n.name === n.selected || n.name === n.text);

/** Rows and cells: what labels one is inside it (GTK's list rows hold their label), never the row above it. */
const ROW_ROLES = new Set(["list item", "table cell", "tree item"]);
/** How deep inside a control its own label is looked for. */
const INNER_LABEL_DEPTH = 4;

/**
 * Unnamed controls' labels: a control with a label inside it (GTK's list row and its label) takes that one (a field
 * doesn't: what is inside a web page's text box is its contents); else the label beside it (see labelFor), but never
 * for a row or a cell (the label above a row is the row above's). `anyAbove`: any text just above an unnamed control
 * names it, sentences too (for secret detection only).
 */
export function inferLabels(nodes: AxNode[], { anyAbove = false } = {}): Map<number, string> {
  const labels = nodes.filter(n => LABEL_ROLES.has(n.role) && n.name && n.bounds);
  const controls = nodes.filter(n => NAMED_BY_ROW.has(n.role) && n.bounds);
  const claimed = new Set(labels.filter(l => controls.some(c => beside(l.bounds!, c.bounds!) !== null)).map(l => l.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  // The control each label is inside (a few levels up at most), for the first label inside each (a read lists a
  // parent before what is in it, and a row's own words before the ones after them).
  const inner = new Map<number, string>();
  for (const l of nodes) {
    if (!LABEL_ROLES.has(l.role) || !/[\p{L}\p{N}]/u.test(l.name)) continue; // not a list's bullet
    let p = l.parent;
    for (let i = 0; p !== null && i < INNER_LABEL_DEPTH; i++) {
      const c = byId.get(p);
      if (!c) break;
      if (INTERACTIVE.has(c.role) && !c.name && !FIELD_ROLES.has(c.role) && !inner.has(c.id)) inner.set(c.id, l.name);
      p = c.parent;
    }
  }
  const out = new Map<number, string>();
  for (const n of nodes) {
    if ((n.name && !namedByValue(n)) || !n.bounds || !INTERACTIVE.has(n.role)) continue;
    const name = inner.get(n.id) ?? (ROW_ROLES.has(n.role) ? null : labelFor(n.bounds, labels, claimed, anyAbove));
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
  // A combo box whose text field is secret is too (GTK's combo box with an entry is named after what is typed in it).
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const id of [...out]) {
    const parent = byId.get(byId.get(id)!.parent ?? NaN);
    if (parent?.role === "combo box") out.add(parent.id);
  }
  return out;
}

/** The window itself (its title is reported as the window's): where looking up from a field stops. */
const WINDOW_ROLES = new Set(["frame", "window", "dialog", "alert", "file chooser", "desktop frame", "application"]);
/** How far up from a secret field its containers are looked at. Keep in step with WITHHELD_LEVELS in ember_atspi.py. */
const WITHHELD_LEVELS = 12;
/** Text as a secret's value is looked for in a name: normalised, without whitespace or U+FFFC (see squash in ember_atspi.py). */
const squash = (s: string) => normalize(s).replace(/\ufffc/g, " ").replace(/\s+/g, "");
/** What a secret field holds (only while it is still in the read: the sidecar sends none), squashed. */
function secretValues(n: AxNode): string[] {
  const found = [n.text, n.selected, n.value === undefined ? undefined : String(n.value)];
  return found.flatMap(v => (v ? [squash(v)] : [])).filter(Boolean);
}
/** Does `text` say one of a secret field's values? A short value (part of a code typed so far) only as a word of its own. */
function holdsValue(text: string | undefined, values: string[]): boolean {
  if (!text || !values.length) return false;
  const whole = squash(text), words = normalize(text).replace(/\s+/g, " ");
  return values.some(v => v.length >= 4 ? whole.includes(v)
    : new RegExp(`(?<![\\p{L}\\p{N}_])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(words));
}

/**
 * Elements whose names say what a secret field (of `secret`) holds: Chromium names a table's cell, an ARIA row or a
 * <div> after the values of the fields in it, GTK a combo box after the option it shows. Its listed containers whose
 * name or text has its value in it, and the field itself when its name has. Only for a field whose contents the read
 * still has (the sidecar withholds these itself, and sends no contents of a field it knows is secret).
 */
export function withheldIds(nodes: AxNode[], secret: Set<number>): Set<number> {
  const out = new Set<number>();
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const n of nodes) {
    if (!secret.has(n.id)) continue;
    const values = secretValues(n);
    if (!values.length) continue;
    let c: AxNode | undefined = n;
    for (let i = 0; c && i <= WITHHELD_LEVELS && !WINDOW_ROLES.has(c.role); i++) {
      if (holdsValue(c.name, values) || (c !== n && holdsValue(c.text, values))) out.add(c.id);
      c = c.parent === null ? undefined : byId.get(c.parent);
    }
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

/** A spreadsheet's cell is named by its address ("B7": LibreOffice Calc). Keep in step with CELL_ADDRESS in ember_atspi.py. */
const CELL_ADDRESS = /^\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}$/;
/**
 * A spreadsheet's cell: its name says where it is, its text what it holds. The sidecar says which cells it read from a
 * sheet's grid (`grid`): a Writer table's cells are named "A1" too, and are not (`grid: false`). An element without
 * the flag (as the policy is handed it) goes by its role and name.
 */
export const isSheetCell = (n: Pick<AxNode, "role" | "name"> & { grid?: boolean }) =>
  n.role === "table cell" && n.grid !== false && CELL_ADDRESS.test(n.name);
/** The row of a spreadsheet's cell ("7" for "B7"). */
const sheetRow = (n: AxNode) => n.name.replace(/^\$?[A-Z]+\$?/, "");
/** States every spreadsheet cell has: not worth a word on each. */
const PLAIN_CELL_STATES = new Set(["enabled", "sensitive", "focusable", "editable", "multi line"]);

/** One row of a spreadsheet's cells on one line, each `[id] B7="what it holds"` with any state worth saying. */
function cellRow(cells: AxNode[]): string {
  const bits = cells.map(c => {
    const secret = isSecretNode(c);
    const states = c.states.filter(s => !PLAIN_CELL_STATES.has(s));
    if (secret) states.push("secret");
    return `[${c.id}] ${c.name}${c.text && !secret ? `=${quote(c.text, 60)}` : ""}${states.length ? ` (${states.join(", ")})` : ""}`;
  });
  return `row ${sheetRow(cells[0])}: ${bits.join("  ")}`;
}

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
  // What secret fields hold is never listed, whatever the sidecar sent (nor does it label anything), nor are the names
  // that say it (a table's cell named after the card number in it).
  const readLabels = inferLabels(read);
  const secretSet = new Set(read.filter(n => isSecretNode(n, readLabels.get(n.id) ?? "")).map(n => n.id));
  const inside = insideSecrets(read, secretSet);
  const withheld = withheldIds(read, secretSet);
  const nodes = inside.size ? read.filter(n => !inside.has(n.id)) : read;
  const labels = inside.size ? inferLabels(nodes) : readLabels;
  // Indented by the elements listed above it: a web page's unnamed layers of <div>s add nothing.
  const level = new Map<number, number>();
  for (const n of nodes) level.set(n.id, n.parent !== null && level.has(n.parent) ? level.get(n.parent)! + 1 : 0);
  // One line per element, but a spreadsheet's cells one line per row (hundreds of cells show at once).
  const units: AxNode[][] = [];
  for (const n of nodes) {
    const prev = units[units.length - 1];
    if (prev && isSheetCell(n) && isSheetCell(prev[0]) && prev[0].parent === n.parent && sheetRow(prev[0]) === sheetRow(n)) prev.push(n);
    else units.push([n]);
  }
  // Too many to list: what says least is left out first (unnamed containers, then text, then rows), in tree order.
  let shown: Set<AxNode[]> | null = null;
  if (units.length > maxLines) {
    const order = units.map((u, i) => ({ u, i, w: Math.max(...u.map(n => weight(n, labels))) })).sort((a, b) => b.w - a.w || a.i - b.i);
    shown = new Set(order.slice(0, maxLines).map(o => o.u));
  }
  const lines: string[] = [];
  const left = [0, 0, 0, 0];
  let omitted = 0;
  for (const unit of units) {
    if (shown && !shown.has(unit)) {
      for (const n of unit) left[weight(n, labels)]++;
      omitted += unit.length;
      continue;
    }
    const n = unit[0];
    if (isSheetCell(n)) { lines.push("  ".repeat(level.get(n.id)!) + cellRow(unit)); continue; }
    const own = withheld.has(n.id) ? "" : n.name;
    const name = own || labels.get(n.id) || "";
    const bits = [`[${n.id}] ${screenWord(n.role)}`];
    if (name) bits.push(quote(name, 80) + (own ? "" : " (label)"));
    const states = n.states.filter(s => !["enabled", "sensitive", "focusable"].includes(s));
    if (!n.states.includes("sensitive") && !n.states.includes("enabled")) states.push("disabled");
    // Contents of password and payment fields are never shown, whatever the sidecar sent.
    const secret = secretSet.has(n.id) || isSecretNode(n, name);
    if (secret) states.push("secret");
    if (states.length) bits.push(`(${states.join(", ")})`);
    if (n.value !== undefined && !secret) bits.push(`value=${n.value}`);
    if (n.actions?.length) bits.push(`actions=${n.actions.map(screenWord).join("/")}`);
    if (n.text && !secret && !withheld.has(n.id)) bits.push(`text=${quote(n.text, opts.maxTextChars ?? 160)}`);
    // What is selected in it: a drop-down's chosen option (as after choose_option), else the text selected in a field.
    const selected = n.selected ?? n.selection;
    if (selected && !secret && !withheld.has(n.id)) bits.push(`selected=${quote(selected, n.selected !== undefined ? 80 : 300)}`);
    if (opts.withBounds && n.bounds) bits.push(`@${n.bounds.x},${n.bounds.y} ${n.bounds.width}x${n.bounds.height}`);
    lines.push("  ".repeat(level.get(n.id)!) + bits.join(" "));
  }
  if (shown) {
    const kinds = [[left[0], "without a name"], [left[1], "text"], [left[2], "rows or cells"], [left[3], "controls"]] as const;
    const what = kinds.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
    lines.push(`… ${omitted} more elements not shown (${what}${left[3] ? "" : "; every control is listed"})`);
  }
  const attrs = `app=${quote(window.app, 60)} window=${quote(window.name, 100)}`;
  return `<screen source="accessibility" ${attrs} untrusted="true">\n${[...opts.header ?? [], ...lines].join("\n")}\n</screen>`;
}

/**
 * The element with the keyboard: the deepest one that says it is focused. LibreOffice says its root pane and the
 * sheet are focused too, ahead of the cell (a read lists parents before what is in them).
 */
export function focusedElement(nodes: AxNode[]): AxNode | null {
  let found: AxNode | null = null;
  for (const n of nodes) if (n.states.includes("focused") && (!found || n.depth > found.depth)) found = n;
  return found;
}

/** True when the app or window matches the user's "never look at" list. */
export function isNeverLook(window: { app: string; name: string }, list: string[]): boolean {
  const hay = `${window.app} ${window.name}`.toLowerCase();
  return list.some(item => item.trim() && hay.includes(item.trim().toLowerCase()));
}
