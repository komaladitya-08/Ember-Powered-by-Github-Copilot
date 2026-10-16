/**
 * The policy engine: every action a worker wants to take is described as a
 * structured ActionRequest and decided here, never by the model. Tiers follow
 * PLAN.md §5: read and reversible actions run automatically, risky ones need
 * the user's click, and some are never done by Ember at all.
 *
 * Labels come from the screen, so they are normalised before matching:
 * look-alike letters, invisible characters and typographic apostrophes can't
 * hide a "Delete" from the risky-word check.
 */

import { isNeverLook, isSecretLabel } from "../perception/elements";
import { parseCombo } from "../hands/borrow";

export type Tier = "read" | "reversible" | "confirm" | "never";
export type Verdict = "allow" | "confirm" | "deny";

export type ActionKind = "read" | "click" | "toggle" | "text" | "select" | "value" | "setting" | "open_app"
  /** Tier 3: with the user's borrowed mouse and keyboard. */
  | "cursor_click" | "cursor_text" | "keys" | "scroll";

export type TextMode = "replace" | "insert" | "append";

export interface ActionRequest {
  taskId: string;
  kind: ActionKind;
  /** App name and window title the action touches ("" for settings; the app's name for launching). */
  app: string;
  window: string;
  /** `name` is the element's own name, or else the label beside it; `secret`: the screen reader judged its contents secret. */
  element?: { role: string; name: string; secret?: boolean };
  /** For text: what will be typed; for settings: the new value; for keys: the combination. */
  value?: string;
  /** For text: replace everything, insert at the caret, or append. */
  mode?: TextMode;
  /** For text: what the field holds now (replacing a lot of it is confirmed). */
  currentText?: string;
  /** The dialog the element sits in (its title and text): "OK" there agrees to what the dialog says. */
  dialog?: { name: string; text: string };
  /** On Ember's own desk (its private display): no app grant needed, full input allowed. */
  onDesk?: boolean;
  /** The user's request this action serves (for the task-alignment check). */
  goal?: string;
  /** Apps whose windows this task has read: text, choices and pastes in another app may carry what was read there. */
  readFrom?: string[];
}

export interface Decision {
  tier: Tier;
  verdict: Verdict;
  reason: string;
  /** Plain sentence for the confirmation bubble, built from the request (never model text). */
  prompt: string;
  /** Set when the app has no grant yet: confirming also asks to remember it. */
  needsGrant?: boolean;
  /** The action itself needs the user's OK every time, whatever the grant. */
  risky?: boolean;
  /** "Always in this app" may be offered (the administrator can turn grants off). */
  remember?: boolean;
  /** False when a risky action names nothing the user asked for (shown in the question). */
  aligned?: boolean;
  /** Ask every time: an earlier "Allow" in this task doesn't cover it. */
  everyTime?: boolean;
  /** The on-screen words that make it risky (checked against what the user asked for). */
  about?: string;
}

export type Grant = "observe" | "act";

export interface PolicyInputs {
  neverLook: () => string[];
  grants: () => Record<string, Grant>;
  /** Max actions per task per minute. */
  rateLimit?: number;
  now?: () => number;
  /** Administrator switches (admin.ts): acting at all, and asking before every action. */
  actionsAllowed?: () => boolean;
  confirmEveryAction?: () => boolean;
  allowGrants?: () => boolean;
  /** Is this app a terminal (Ember never opens or types into one)? */
  isTerminalApp?: (name: string) => boolean;
}

/** Latin look-alikes from Cyrillic and Greek, enough to keep "Dеlete" (Cyrillic е) from passing as harmless. */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ү": "y", "һ": "h",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
};

/** What a label says, ready for matching: compatibility forms folded, invisible characters gone, look-alikes mapped. */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC")
    .replace(/[\p{Cf}\u00ad]/gu, "")
    .replace(/[\u2019\u02bc\u2018`\u00b4]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase()
    .replace(/[\u0080-\uffff]/g, c => CONFUSABLES[c] ?? c);
}

/** Words on buttons that make an action hard to undo or visible to others. */
const RISKY = /\b(send|post|submit|publish|share|delete|remove|erase|discard|overwrite|replace|empty|format|buy|pay|order|purchase|checkout|install|uninstall|upload|transfer|reply|forward|sign|accept|approve|confirm|authori[sz]e|grant|trust|merge|run|execute|reset|clear|archive|revoke|unsubscribe|trash|wipe|destroy|quit|close without saving|don't save|log ?out|sign ?out|shut ?down|restart|reboot|power off|kill|terminate|end process|force stop|donate|book now|deploy|subscribe|leave (the )?(group|chat|conversation|meeting|team|channel))\b/;

/**
 * Text in other languages, ready for matching: compatibility forms folded, invisible characters and
 * accents gone ("Löschen" and "Loschen" alike), Cyrillic left as it is (no look-alike folding here).
 */
export function foldLabel(s: string): string {
  return s.normalize("NFKC").replace(/[\p{Cf}­]/gu, "").replace(/[’ʼ‘`]/g, "'").toLowerCase()
    .normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC").replace(/\s+/g, " ");
}

/**
 * The same in the languages RHEL desktops commonly use: infinitives and imperatives (the forms buttons
 * use) for deleting, removing, emptying, sending, submitting, replying, forwarding, sharing, publishing,
 * buying, ordering, paying, transferring money, installing, resetting, formatting, signing out, confirming,
 * accepting, discarding, closing without saving, replacing and overwriting, merging, quitting, running programs, moving to
 * the trash, archiving, restarting, subscribing, signing and uploading (GTK's and Nautilus's own words where they have them).
 * Whole words only; words that are also everyday labels ("Formato", "Zahlen", "Ordina" = sort, "Firma") are left out.
 * Written with their accents (folded when the pattern is built).
 */
export const RISKY_WORDS: Record<string, string[]> = {
  fr: ["supprimer", "supprimez", "supprime", "suppression", "effacer", "effacez", "efface", "retirer", "retirez", "enlever", "enlevez",
    "vider", "videz", "envoyer", "envoyez", "envoie", "soumettre", "soumettez", "valider", "validez", "répondre", "répondez",
    "transférer", "transférez", "partager", "partagez", "publier", "publiez", "commander", "commandez", "passer (la )?commande",
    "acheter", "achetez", "payer", "payez", "installer", "installez", "désinstaller", "désinstallez", "réinitialiser", "réinitialisez",
    "formater", "formatez", "déconnecter", "déconnexion", "confirmer", "confirmez", "accepter", "acceptez", "accepte",
    "ne pas enregistrer", "sans enregistrer", "quitter", "exécuter", "exécutez", "lancer", "lancez",
    "(mettre|déplacer|jeter) (à|dans|vers) la corbeille", "remplacer", "remplacez", "écraser", "écrasez", "fusionner", "archiver",
    "redémarrer", "éteindre", "s'abonner", "se désabonner", "signer", "téléverser"],
  de: ["löschen", "lösche", "loeschen", "entfernen", "entferne", "leeren", "senden", "sende", "absenden", "versenden", "abschicken",
    "verschicken", "einreichen", "übermitteln", "antworten", "antworte", "weiterleiten", "teilen", "freigeben", "veröffentlichen",
    "kaufen", "bestellen", "bestelle", "zahlungspflichtig", "bezahlen", "jetzt zahlen", "überweisen", "überweisung", "installieren",
    "deinstallieren", "zurücksetzen", "formatieren", "abmelden", "ausloggen", "bestätigen", "akzeptieren", "annehmen", "zustimmen",
    "verwerfen", "nicht speichern", "ohne speichern", "beenden", "ausführen", "in den papierkorb", "ersetzen", "ersetze", "überschreiben",
    "zusammenführen", "ohne zu speichern", "archivieren", "neu starten", "herunterfahren", "abonnieren", "abbestellen", "unterschreiben",
    "signieren", "hochladen"],
  es: ["eliminar", "elimina", "elimine", "borrar", "borra", "borre", "suprimir", "suprime", "suprima", "quitar", "quita", "quite",
    "vaciar", "enviar", "envía", "envíe", "responder", "responde", "responda", "reenviar", "reenvía", "compartir", "comparte",
    "comparta", "publicar", "publique", "comprar", "compra", "compre", "(realizar|hacer|tramitar|finalizar) pedido", "pagar", "paga",
    "pague", "transferir", "transfiere", "instalar", "instala", "instale", "desinstalar", "restablecer", "restablece", "formatear",
    "cerrar sesión", "desconectar", "confirmar", "confirma", "confirme", "aceptar", "acepta", "acepte", "acepto", "descartar",
    "descarta", "no guardar", "sin guardar", "salir", "ejecutar", "ejecuta", "ejecute", "ejecutarlo", "ejecutarlos",
    "(mover|tirar) a la papelera", "reemplazar", "reemplaza", "reemplace", "reemplazarlo", "sustituir", "sobrescribir", "sobreescribir",
    "mezclar", "fusionar", "archivar", "reiniciar", "apagar", "suscribirse", "darse de baja", "firmar", "subir"],
  it: ["eliminare", "elimina", "elimini", "cancellare", "cancella", "rimuovere", "rimuovi", "svuotare", "svuota", "inviare", "invia",
    "spedire", "spedisci", "rispondere", "rispondi", "inoltrare", "inoltra", "condividere", "condividi", "pubblicare", "pubblica",
    "acquistare", "acquista", "comprare", "ordina ora", "effettua (l')?ordine", "pagare", "paga", "bonifico", "installare", "installa",
    "disinstallare", "disinstalla", "reimpostare", "reimposta", "formattare", "formatta", "disconnetti", "esci", "confermare",
    "conferma", "accettare", "accetta", "accetto", "scarta", "scartare", "non salvare", "senza salvare", "eseguire", "esegui", "eseguirlo",
    "eseguirli", "(sposta|spostare|spostalo|spostali) nel cestino", "cestina", "sostituisci", "sostituire", "sostituirlo", "sovrascrivi",
    "sovrascrivere", "unisci", "archivia", "riavvia", "spegni", "iscriviti", "annulla (l')?iscrizione", "carica file"],
  pt: ["excluir", "exclua", "exclui", "apagar", "apague", "apaga", "deletar", "remover", "remova", "esvaziar", "esvazie", "envie",
    "responda", "encaminhar", "encaminhe", "compartilhar", "compartilhe", "partilhar", "partilhe", "comprar", "compre",
    "(fazer|finalizar) pedido", "pague", "transfira", "redefinir", "redefina", "(terminar|encerrar) sessão", "sair", "aceitar",
    "aceite", "aceito", "concordo", "concordar", "não salvar", "não guardar", "sem salvar", "sem guardar", "executar", "executa",
    "mover para (a lixeira|o lixo|a reciclagem)", "substituir", "substitua", "sobrescrever", "sobrescreva", "mesclar", "arquivar",
    "reiniciar", "desligar", "inscrever-se", "assinar"],
  nl: ["verwijderen", "verwijder", "leegmaken", "prullenbak legen", "verzenden", "verzend", "versturen", "verstuur", "indienen",
    "beantwoorden", "antwoorden", "doorsturen", "delen", "publiceren", "publiceer", "kopen", "koop", "bestellen", "bestel",
    "afrekenen", "betalen", "betaal", "overmaken", "overboeken", "installeren", "installeer", "de-installeren", "resetten",
    "opnieuw instellen", "formatteren", "afmelden", "uitloggen", "bevestigen", "bevestig", "accepteren", "accepteer", "akkoord",
    "niet opslaan", "verwerpen", "afsluiten", "vervangen", "vervang", "overschrijven", "zonder opslaan", "naar (de )?prullenbak",
    "samenvoegen"],
  pl: ["usuń", "usunąć", "skasuj", "opróżnij", "wyślij", "wysłać", "odpowiedz", "przekaż", "udostępnij", "opublikuj", "kup",
    "kupuję", "zamów", "zamawiam", "zapłać", "płacę", "przelew", "zainstaluj", "odinstaluj", "resetuj", "zresetuj", "formatuj",
    "sformatuj", "wyloguj", "potwierdź", "zatwierdź", "akceptuj", "zaakceptuj", "zgadzam się", "odrzuć", "nie zapisuj", "zastąp", "zastąpić",
    "nadpisz", "nadpisać", "bez zapisywania", "do kosza", "scal"],
  ru: ["удалить", "удали", "удалите", "убрать", "очистить", "очисти", "отправить", "отправь", "отправьте", "послать", "ответить",
    "ответь", "ответьте", "переслать", "перешли", "поделиться", "поделись", "опубликовать", "опубликуй", "купить", "купи",
    "оформить заказ", "заказать", "закажи", "оплатить", "оплати", "заплатить", "установить", "установи", "сбросить", "сбрось",
    "форматировать", "выйти", "выход", "подтвердить", "подтверди", "подтвердите", "принять", "прими", "согласен", "согласиться",
    "не сохранять", "заменить", "замени", "перезаписать", "без сохранения", "в корзину", "объединить"],
  sv: ["ta bort", "radera", "töm papperskorgen", "skicka", "svara", "vidarebefordra", "publicera", "köp nu", "köpa", "beställ",
    "betala", "installera", "avinstallera", "återställ", "logga ut", "bekräfta", "acceptera", "godkänn", "spara inte", "ersätt",
    "skriv över", "utan att spara", "till papperskorgen"],
  da: ["slet", "fjern", "tøm", "svar", "videresend", "køb", "bestil", "betal", "installer", "afinstaller", "nulstil", "log ud",
    "bekræft", "accepter", "godkend", "gem ikke", "erstat", "overskriv", "uden at gemme", "i papirkurven"],
  nb: ["slett", "kjøp", "bestill", "avinstaller", "tilbakestill", "logg ut", "bekreft", "godta", "aksepter", "ikke lagre", "erstatt",
    "overskriv", "uten å lagre", "i papirkurven"],
  fi: ["poista", "tyhjennä", "lähetä", "vastaa", "välitä", "jaa", "julkaise", "osta", "tilaa nyt", "maksa", "asenna", "nollaa",
    "kirjaudu ulos", "vahvista", "hyväksy", "älä tallenna", "korvaa", "tallentamatta", "roskakoriin"],
  cs: ["smazat", "smaž", "odstranit", "odstraň", "vysypat", "odeslat", "odešli", "odpovědět", "přeposlat", "sdílet", "publikovat",
    "zveřejnit", "koupit", "objednat", "zaplatit", "nainstalovat", "instalovat", "odinstalovat", "resetovat", "formátovat",
    "naformátovat", "odhlásit", "potvrdit", "přijmout", "souhlasím", "neukládat", "nahradit", "přepsat", "bez uložení", "do koše"],
  tr: ["sil", "kaldır", "boşalt", "gönder", "yanıtla", "cevapla", "ilet", "paylaş", "yayınla", "satın al", "sipariş ver", "ödeme yap",
    "ödemeyi tamamla", "havale", "yükle", "sıfırla", "biçimlendir", "çıkış yap", "oturumu kapat", "onayla", "kabul et",
    "kabul ediyorum", "kaydetme", "üzerine yaz", "kaydetmeden", "çöpe taşı"],
};
/** Scripts without spaces between words: matched anywhere in the label. */
export const RISKY_ANYWHERE: Record<string, string[]> = {
  ja: ["削除", "消去", "送信", "返信", "転送", "共有", "公開", "投稿", "購入", "注文", "決済", "支払", "振込", "送金", "インストール",
    "リセット", "初期化", "フォーマット", "ログアウト", "サインアウト", "確定", "同意", "承認", "破棄", "保存しない", "空にする", "終了", "置き換え", "置換", "上書き", "保存せず", "ゴミ箱"],
  zh: ["删除", "刪除", "移除", "清空", "清除", "发送", "發送", "提交", "回复", "回覆", "转发", "轉發", "分享", "共享", "发布", "發佈",
    "發布", "发表", "發表", "购买", "購買", "下单", "下單", "结算", "結算", "支付", "付款", "转账", "轉帳", "汇款", "匯款", "安装",
    "安裝", "卸载", "卸載", "重置", "格式化", "注销", "註銷", "登出", "退出", "同意", "接受", "放弃", "放棄", "不保存", "替换", "替換", "覆盖", "覆蓋", "回收站", "废纸篓", "廢紙簍"],
  ko: ["삭제", "제거", "비우기", "전송", "보내기", "제출", "답장", "전달", "공유", "게시", "구매", "구입", "주문", "결제", "이체",
    "송금", "설치", "초기화", "포맷", "로그아웃", "동의", "수락", "저장 안 함", "종료", "바꾸기", "덮어쓰기", "저장하지 않", "휴지통"],
};
const all = (lists: Record<string, string[]>) => foldLabel(Object.values(lists).flat().join("|"));
const RISKY_INTL_SOURCE = `(^|[^\\p{L}\\p{N}])(?<word>${all(RISKY_WORDS)})(?=$|[^\\p{L}\\p{N}])|(?<cjk>${all(RISKY_ANYWHERE)})`;
const RISKY_INTL = new RegExp(RISKY_INTL_SOURCE, "u");

/** Answers that agree to whatever a dialog asks: risky in a dialog, or when the window's own title is about something risky. */
const AFFIRMATIVE = /^\s*(yes|ok|okay|continue|proceed|allow|confirm|do it|i understand|got it|agree)\b/;
/** The same in other languages (folded like RISKY_WORDS): "Ja", "Oui", "Sí", "Да", "Tak", "Weiter". */
export const AFFIRMATIVE_WORDS = ["oui", "d'accord", "continuer", "poursuivre", "autoriser", "compris", "j'ai compris",
  "ja", "weiter", "fortfahren", "zulassen", "erlauben", "einverstanden", "verstanden", "alles klar",
  "sí", "vale", "continuar", "permitir", "de acuerdo", "entendido",
  "sì", "continua", "procedi", "consenti", "va bene", "ho capito",
  "sim", "prosseguir", "de acordo", "entendi",
  "doorgaan", "toestaan", "begrepen",
  "tak", "dalej", "kontynuuj", "zezwól", "rozumiem",
  "да", "ок", "продолжить", "разрешить", "хорошо", "понятно",
  "fortsätt", "tillåt", "okej", "fortsæt", "tillad", "fortsett", "tillat",
  "kyllä", "jatka", "salli", "ano", "pokračovat", "povolit", "rozumím", "evet", "tamam", "devam", "devam et", "izin ver"];
/** CJK answers: the whole label, maybe with its access key ("はい(Y)"). */
export const AFFIRMATIVE_WHOLE = ["はい", "続行", "許可", "確認", "了解", "是", "确定", "確定", "好", "继续", "繼續", "允许", "允許", "确认",
  "예", "네", "확인", "계속", "허용"];
const AFFIRMATIVE_INTL = new RegExp(`^\\s*(${foldLabel(AFFIRMATIVE_WORDS.join("|"))})(?=$|[^\\p{L}\\p{N}])|^\\s*(${foldLabel(AFFIRMATIVE_WHOLE.join("|"))})\\s*([(（][^)）]*[)）])?\\s*$`, "u");
const isAffirmative = (s: string) => AFFIRMATIVE.test(normalizeLabel(s)) || AFFIRMATIVE_INTL.test(foldLabel(s));
/** Fields Ember never fills: secrets and payment details (an expiry date only beside a card: the screen reader's list has those). */
const SECRET_FIELD = /\b(password|passphrase|passcode|pin|card ?number|credit ?card|cvv|cvc|security code|iban|routing number|account number|one-time code|otp|2fa|recovery code|secret)\b/;
/**
 * Titles of authentication prompts, by how such a title starts: never words that turn up in ordinary
 * titles too ("firewall-notes.txt", a page about sudo), so those windows are read and used as usual.
 */
const SECURITY_TITLE = /^\s*(authenticat(e|ion)\b.*\b(required|request)\b|authenticate\s*$|(password|passphrase|pin) (required|request(ed)?)\b|enter (the |your |a )?(password|passphrase|pin)\b|unlock\b.*\b(keyring|private key|password|passphrase)\b|\[sudo\]|sudo password\b)/;
/** Programs that only ask for passwords (polkit agents, the keyring's and GnuPG's prompts), and the firewall's settings. */
const SECURITY_APP = /polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|^firewall-config$|(^|\s)gnome-shell(\s|$)/i;

/** Is this an authentication or security prompt (polkit, sudo, keyring…)? Ember stays out of those. */
export function isSecurityWindow(w: { app?: string; title?: string; name?: string }): boolean {
  // GNOME Shell draws its own password prompts (polkit, keyring) in its own window: while it has the
  // keyboard, Ember treats it as one (it never acts in the shell anyway).
  return SECURITY_APP.test((w.app ?? "").trim()) || SECURITY_TITLE.test(normalizeLabel(w.title ?? w.name ?? ""));
}

export const isRiskyLabel = (s: string) => RISKY.test(normalizeLabel(s)) || RISKY_INTL.test(foldLabel(s));
/** One list with the screen reader's (which also withholds these fields' contents), plus look-alike folding. */
export const isSecretField = (s: string) => SECRET_FIELD.test(normalizeLabel(s)) || isSecretLabel(normalizeLabel(s));

const ACTIVATING_ROLES = /button|link|menu item|check box|radio|toggle|switch|tab/;
/** Keys that activate the focused control (with Shift too, and the Ctrl+M / Ctrl+J line-feed equivalents), as keyFamily spells them. */
const ACTIVATE_KEY = /^((shift|ctrl|alt)\+)?(return|space)$|^ctrl\+(m|j)$/;
/** Is `keys` a key that activates whatever has focus (Enter, Space and their keypad twins)? */
export const isActivatingKey = (keys: string) => { const k = canonicalKeys(keys); return !!k && ACTIVATE_KEY.test(keyFamily(k)); };
/** Keypad and ISO twins act like the main keys (KP_Delete deletes, KP_Enter submits): judged as those. */
const KEY_TWINS: Record<string, string> = {
  kp_delete: "delete", kp_decimal: "delete", kp_enter: "return", iso_enter: "return", linefeed: "return", enter: "return",
  kp_space: "space", kp_tab: "tab", iso_left_tab: "tab", kp_add: "plus", kp_subtract: "minus", kp_equal: "equal",
  kp_multiply: "asterisk", kp_divide: "slash", kp_home: "home", kp_end: "end", kp_prior: "prior", kp_page_up: "prior",
  kp_next: "next", kp_page_down: "next", kp_insert: "insert", kp_left: "left", kp_right: "right", kp_up: "up", kp_down: "down",
  kp_f1: "f1", kp_f2: "f2", kp_f3: "f3", kp_f4: "f4",
};
/** A canonical combination with its key as the main key it acts like ("shift+kp_delete" → "shift+delete"). */
export function keyFamily(k: string): string {
  const parts = k.split("+");
  const key = parts.pop()!;
  return [...parts, KEY_TWINS[key] ?? (/^kp_\d$/.test(key) ? key.slice(3) : key)].join("+");
}
/** Alt+letter presses whichever control has that underlined letter: Ember can't tell which. */
const MNEMONIC_KEY = /^alt\+(shift\+)?[a-z0-9]$/;
/** A modifier by its side-less name: Control_R is Ctrl as much as Control_L (apps see the same ControlMask). */
const MODIFIER_NAMES: Record<string, string> = { control: "ctrl", ctrl: "ctrl", alt: "alt", shift: "shift", super: "super", meta: "super", hyper: "super", mod4: "super" };
const modifierName = (m: string) => MODIFIER_NAMES[m.toLowerCase().replace(/_[lr]$/, "")] ?? m.toLowerCase();
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "super"];
/** Other names people (and models) give the logo key. */
const LOGO_KEY = /^\s*(win|windows|cmd|command|logo|mod4)\s*$/i;

/**
 * One spelling for a key combination, the way Ember's keyboard will press it (parseCombo): modifiers
 * in a fixed order (ctrl, alt, shift, super) and the key's own name in lower case, so "Alt + Ctrl + Del"
 * is "ctrl+alt+delete" and "Super_L" is "super_l". null when Ember's keyboard wouldn't understand it.
 */
export function canonicalKeys(keys: string): string | null {
  try {
    const { modifiers, key } = parseCombo(keys.split("+").map(t => (LOGO_KEY.test(t) ? "super" : t)).join("+"));
    if (/\s/.test(key)) return null;
    // Keys by number ("0x74", "U0074", "U+0074"): X takes them too, so any key hides behind them. Never pressed.
    if (/^(0x[0-9a-f]+|u\+?[0-9a-f]{2,8})$/i.test(key)) return null;
    const mods = [...new Set(modifiers.map(modifierName))].sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    return [...mods, key.toLowerCase()].join("+");
  } catch {
    return null;
  }
}

/** @deprecated canonicalKeys (kept for callers that want a string either way). */
export function normalizeKeys(keys: string): string {
  return canonicalKeys(keys) ?? keys.toLowerCase().replace(/\s+/g, "");
}

/**
 * Keys only the user presses (`k` from canonicalKeys): the logo key with anything, power, media and
 * screenshot keys, virtual consoles, the run dialog, terminals, locking and logging out, switching
 * workspaces, and Ember's own shortcuts (Ctrl+Alt+Y/N/A/X/Space/E/M/End), so a task can never answer
 * its own question or stop, hide or reconfigure Ember. Shift doesn't change that.
 */
export function isSystemKey(k: string): boolean {
  const parts = keyFamily(k).split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  if (mods.has("super") || /^(super|meta|hyper)(_[lr])?$/.test(key)) return true;
  if (/^xf86/.test(key) || /^(print|sys_req|sysrq)$/.test(key)) return true;
  const ctrlAlt = mods.has("ctrl") && mods.has("alt");
  if (ctrlAlt && /^f\d{1,2}$/.test(key)) return true;
  if (mods.has("alt") && !mods.has("ctrl") && /^f[12]$/.test(key)) return true;
  return ctrlAlt && /^(backspace|delete|tab|t|l|up|down|left|right|y|n|a|x|space|e|m|end)$/.test(key);
}

const canonicalSet = (list: string[]) => new Set(list.map(k => canonicalKeys(k) ?? k));
/** Shortcuts that only move, select, copy, paste, undo, format, search or zoom: fine on Ember's desk. */
const SAFE_COMBOS = canonicalSet(["ctrl+a", "ctrl+c", "ctrl+x", "ctrl+v", "ctrl+z", "ctrl+y", "ctrl+shift+z", "ctrl+b", "ctrl+i", "ctrl+u",
  "ctrl+f", "ctrl+g", "ctrl+h", "ctrl+s", "ctrl+shift+s", "ctrl+n", "ctrl+t", "ctrl+l", "ctrl+o", "ctrl+home", "ctrl+end", "ctrl+left", "ctrl+right",
  "ctrl+up", "ctrl+down", "ctrl+shift+left", "ctrl+shift+right", "ctrl+shift+home", "ctrl+shift+end", "ctrl+backspace", "ctrl+plus", "ctrl+minus",
  "ctrl+equal", "ctrl+0", "ctrl+tab", "ctrl+shift+tab", "ctrl+prior", "ctrl+next", "ctrl+pageup", "ctrl+pagedown"]);
/** Shortcuts that delete, send, close or quit, whatever has focus. */
const DESTRUCTIVE_KEYS = canonicalSet(["delete", "shift+delete", "ctrl+delete", "ctrl+shift+delete", "ctrl+return", "alt+return", "ctrl+shift+return",
  "alt+f4", "ctrl+q", "ctrl+w", "ctrl+shift+w", "ctrl+shift+q"]);
/** Keys that paste whatever the clipboard holds. */
const PASTE_KEYS = canonicalSet(["ctrl+v", "ctrl+shift+v", "shift+insert"]);

/** Whole words or phrases (written with their accents, folded like RISKY_WORDS) anywhere in a text. */
const anyOf = (list: string[]) => new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(list.join("|"))})(?=$|[^\\p{L}\\p{N}])`, "u");
/** A label for the checks below: look-alikes mapped, then accents dropped ("Ausführen" is "ausfuhren"). */
const plainText = (s: string) => foldLabel(normalizeLabel(s));
/**
 * Making a file executable or running one: "Allow executing file as program", "Run in Terminal", "Trust and Launch",
 * and the same in the languages of RHEL's file manager (its own words, from Nautilus 3.28's translations).
 */
const RUNS_PROGRAM = /\b(allow(ed)? execut(ing|e)|execut(able|e) as (a )?program|run as (a )?program|run in (a )?terminal|launch as (a )?program|make (it |the file |file )?executable|trust and launch)\b/;
const TRUST_AND_LAUNCH = anyOf(["vertrauen und starten", "faire confiance et lancer", "confiar y ejecutar", "dai fiducia e lancia", "confiar e iniciar"]);
/** By its words: running with a program or a terminal ("Datei als Programm ausführen", "Lancer dans un terminal", "Esegui nel terminale"). */
const RUN_WORDS = ["run", "execute", "executing", "execution", "launch", "ausführen", "ausführung", "exécuter", "exécution", "lancer", "ejecutar",
  "ejecución", "eseguire", "esegui", "esecuzione", "executar", "execução"];
const RUN_WORD = anyOf(RUN_WORDS);
const PROGRAM_WORD = anyOf(["programs?", "programm", "programmes?", "programas?", "programma", "terminal", "terminale"]);
/** A check box that is only "Execute" ("Ausführen:", "Exécution :"), or says the file is executable ("Is executable", "Ausführbar"). */
const RUN_ONLY = new RegExp(`^\\s*(${foldLabel(RUN_WORDS.join("|"))})\\s*:?\\s*$`, "u");
const EXECUTABLE_WORD = anyOf(["executables?", "ausführbar(e[nrs]?)?", "exécutables?", "ejecutables?", "eseguibil[ei]", "executáve(l|is)"]);
const TOGGLE_ROLES = /check box|toggle|switch/;
/**
 * The file manager's "Do you want to run …, or display its contents?" question (and its autorun one), as Nautilus
 * versions word it: its "Run" runs the file.
 */
const RUN_FILE_DIALOG = anyOf(["do you want to run", "display its contents", "would you like to run it", "inhalt anzeigen",
  "automatisch ausgeführt werden soll", "afficher son contenu", "souhaitez-vous le lancer", "(ver|mostrar) su contenido", "quiere ejecutarlo",
  "il suo contenuto", "visualizzarne il contenuto", "eseguirlo", "(exibir|mostrar) (o )?seu conteúdo", "gostaria de executá-lo"]);
/** That dialog's "Run" ("Ausführen", "Lancer", "Ejecutar", "Esegui", "Executar"). */
const RUN_ANSWER = /^(run|execute|launch|ausfuhren|lancer|ejecutar|esegui|executar)\b/;
/** Does activating this control make a file executable or run one? */
function runsProgram(role: string, name: string, dialog?: { name: string; text: string }): boolean {
  const label = plainText(name);
  if (RUNS_PROGRAM.test(label) || TRUST_AND_LAUNCH.test(label)) return true;
  if (ACTIVATING_ROLES.test(role) && RUN_WORD.test(label) && PROGRAM_WORD.test(label)) return true;
  // The file's execute bit, by a check box on its Permissions page.
  if (TOGGLE_ROLES.test(role) && (RUN_ONLY.test(label) || EXECUTABLE_WORD.test(label))) return true;
  const asks = plainText(`${dialog?.name ?? ""} ${dialog?.text ?? ""}`);
  return RUN_ANSWER.test(label) && (RUN_FILE_DIALOG.test(asks) || EXECUTABLE_WORD.test(asks));
}
/** "Paste" menu items and buttons, in the languages above. */
const PASTE_LABEL = /^(paste|einfugen|coller|pegar|incolla|colar|plakken|wklej)(?=$|[^\p{L}])/u;
/** Apps named in a question: "Thunderbird", "Thunderbird and Files", "A, B and C". */
const appList = (apps: string[]) => (apps.length > 1 ? `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1]}` : apps[0] ?? "");
const STOP = new Set(["the", "and", "for", "with", "this", "that", "all", "now", "you", "your", "button", "item"]);
const words = (s: string) => foldLabel(s).match(/[\p{L}\p{N}]{3,}/gu)?.filter(w => !STOP.has(w)) ?? [];
/** Rough stem, so "deleting", "deleted" and "delete" match. */
const stem = (w: string) => w.replace(/(ing|ed|es|s|e)$/, "");
/** The same word, roughly: one stem, or one starts the other ("invia" and "inviare", "lösche" and "löschen"). */
const sameWord = (a: string, b: string) => {
  const x = stem(a), y = stem(b);
  return x === y || (Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x)));
};
/** The risky words and phrases in a label, in any of the languages above ("log out", "ta bort", "删除"). */
function riskyTerms(s: string): string[] {
  const out = [...normalizeLabel(s).matchAll(new RegExp(RISKY.source, "g"))].map(m => m[0]);
  for (const m of foldLabel(s).matchAll(new RegExp(RISKY_INTL_SOURCE, "gu"))) out.push(m.groups?.word ?? m.groups?.cjk ?? m[0]);
  return out;
}

/**
 * Task alignment: does a risky control's name share a word with what the user
 * asked for? "Send" in "send the report to Ana" does; "Delete all" while filling in
 * a form doesn't, and the question then says so (words on screen can't make it look asked-for).
 * When the control's name has a risky verb, that verb itself must be in the request:
 * "Delete all my form data" doesn't become asked-for by sharing "form" with "fill in the form".
 */
export function alignedWithGoal(goal: string | undefined, element: string): boolean {
  if (!goal) return true;
  const asked = words(goal);
  const wanted = (w: string) => asked.some(a => sameWord(a, w));
  const all = words(element);
  const risky = all.filter(w => isRiskyLabel(w));
  if (risky.length) {
    if (!risky.some(wanted)) return false;
    // The verb is what the user asked for; what it acts on must be too ("Send money to…" isn't "send the report").
    const rest = all.filter(w => !isRiskyLabel(w));
    return rest.length === 0 || rest.some(wanted);
  }
  // A risky phrase, or a word in a script without spaces: the request must say it too.
  const terms = riskyTerms(element);
  if (terms.length) {
    const said = `${normalizeLabel(goal)} ${foldLabel(goal)}`;
    return terms.some(t => said.includes(t));
  }
  return all.some(wanted);
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const quote = (s: string, max = 60) => `“${s.length > max ? s.slice(0, max - 1) + "…" : s}”`;
const visible = (s: string) => s.replace(/\n/g, "⏎").replace(/\t/g, "⇥");

/** Keys as the rest of Ember writes them: "Ctrl+S", "Enter", "Esc", "keypad Delete". */
const KEY_LABELS: Record<string, string> = {
  ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", return: "Enter", iso_enter: "Enter", escape: "Esc", backspace: "Backspace",
  prior: "Page Up", next: "Page Down", space: "Space", plus: "+", minus: "-", equal: "=", comma: ",", period: ".", slash: "/",
  backslash: "\\", semicolon: ";", apostrophe: "'", grave: "`", bracketleft: "[", bracketright: "]", asterisk: "*",
};
const keyWord = (p: string): string => KEY_LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
/** A key combination for the user to read, built from its canonical form (never the model's own spelling); null if Ember can't press it. */
export function keyLabel(keys: string): string | null {
  const k = canonicalKeys(keys);
  if (!k) return null;
  return k.split("+").map(p => (/^kp_./.test(p) ? `keypad ${keyWord(p.slice(3))}` : keyWord(p))).join("+");
}

function describe(r: ActionRequest, withApp = true): string {
  const el = r.element ? `${r.element.name ? quote(r.element.name) : "the"} ${r.element.role}` : "";
  const where = r.app && withApp ? ` in ${r.app}` : "";
  const replacing = r.mode === "replace" && (r.currentText ?? "").length > 0;
  switch (r.kind) {
    case "click": return `Click ${el}${where}?`;
    case "toggle": return `Switch ${el}${where}?`;
    case "text": return replacing ? `Replace the text in ${el}${where} with ${quote(visible(r.value ?? ""))}?` : `Type ${quote(visible(r.value ?? ""))} into ${el}${where}?`;
    case "select": return `Choose ${quote(r.value ?? "")} in ${el}${where}?`;
    case "value": return `Set ${el} to ${r.value}${where}?`;
    case "setting": return `Change the setting ${quote(r.value ?? "")}?`;
    case "open_app": return `Open ${quote(r.value ?? "")}?`;
    case "cursor_click": return `Borrow your mouse to click ${el}${where}?`;
    case "cursor_text": return `Borrow your mouse and keyboard to ${replacing ? "replace the text in" : "type"} ${replacing ? `${el} with ${quote(visible(r.value ?? ""))}` : `${quote(visible(r.value ?? ""))} into ${el}`}${where}?`;
    case "keys": return `Borrow your keyboard to press ${keyLabel(r.value ?? "") ?? quote(r.value ?? "", 30)}${r.element ? ` on ${el}` : ""}${where}?`;
    case "scroll": return `Borrow your mouse to scroll ${el} ${r.value ?? ""}${where}?`;
    default: return `Read ${r.window || r.app}?`;
  }
}

/** Why an action needs the user's OK; `about`: the on-screen words that make it so; `note`: added to the question. */
type Risk = { reason: string; about?: string; note?: string };

export class PolicyEngine {
  private recent = new Map<string, number[]>();

  constructor(private o: PolicyInputs) {}

  decide(r: ActionRequest): Decision {
    return this.judge(r, true);
  }

  /** The same decision again, for a request already counted (the element under a key changed once its window was in front). */
  recheck(r: ActionRequest): Decision {
    return this.judge(r, false);
  }

  private judge(r: ActionRequest, count: boolean): Decision {
    const d = this.decideBase(r, count);
    if (d.verdict === "deny") return d;
    // "Always in this app" is for ordinary steps; a risky or off-task question is answered for this once only.
    const remember = (this.o.allowGrants?.() ?? true) && !!d.needsGrant && !d.risky;
    // Risky and off-task: say so in the question, so a page that talked Ember into it is easy to spot.
    if (d.about && !alignedWithGoal(r.goal, d.about)) {
      return { ...d, remember: false, aligned: false, everyTime: true, reason: `${d.reason}; not something the user asked for`, prompt: `${d.prompt} You didn't ask for this, so say no if it looks wrong.` };
    }
    // The administrator wants a click before every action.
    if (d.tier !== "read" && this.o.confirmEveryAction?.()) {
      return d.verdict === "allow"
        ? { ...d, verdict: "confirm", tier: "confirm", reason: "your organisation asks you to confirm every action", remember: false, everyTime: true }
        : { ...d, remember: false, everyTime: true };
    }
    return { ...d, remember };
  }

  /**
   * Is this request hard to undo or visible to others, whatever the app's grant?
   * `about`: the on-screen words that make it so, when there are any.
   */
  private riskOf(r: ActionRequest): Risk | null {
    const name = r.element?.name ?? "";
    const role = r.element?.role ?? "";
    // "OK" / "Yes" agrees to whatever its dialog asks (in-page dialogs keep the browser's title), and in a
    // "Delete 500 files?" window to that window's question.
    const agrees = isAffirmative(name) && (!!r.dialog || isRiskyLabel(r.window));
    const asks = r.dialog ? `${name} ${r.dialog.name} ${r.dialog.text}` : `${name} ${r.window}`;
    // What the dialog says, in the question: on the desk (or behind Ember) the user may not see it.
    const says = (r.dialog ? r.dialog.text.trim() || r.dialog.name : r.window).replace(/\s+/g, " ").trim();
    const note = says ? `It says: ${quote(says, 90)}.` : undefined;
    switch (r.kind) {
      case "click": case "toggle": case "cursor_click":
        if (isRiskyLabel(name)) return { reason: "this action may be hard to undo or visible to others", about: name };
        if (agrees) return { reason: r.dialog && !isRiskyLabel(asks) ? "this answers a dialog, and Ember can't be sure what it agrees to" : "this answers a dialog about something hard to undo", about: asks, note };
        return null;
      case "select":
        return isRiskyLabel(r.value ?? "") ? { reason: "this choice may be hard to undo or visible to others", about: r.value } : null;
      case "text": case "cursor_text": {
        if (/[\n\r\t]/.test(r.value ?? "")) return { reason: "the text contains a line break or tab, which can submit a form or move to another field" };
        const current = r.currentText ?? "";
        if (r.mode === "replace" && (current.length > 80 || current.includes("\n"))) return { reason: `this replaces all ${current.length >= 200 ? "the" : current.length} characters already there` };
        return null;
      }
      case "keys": {
        // Keypad twins are judged as the keys they act like (KP_Delete deletes, Ctrl+KP_Enter sends).
        const k = keyFamily(canonicalKeys(r.value ?? "") ?? "");
        if (DESTRUCTIVE_KEYS.has(k)) return { reason: "this shortcut can delete, send or close things" };
        if (ACTIVATE_KEY.test(k)) {
          // Enter or Space on a focused button is a click on that button.
          if (ACTIVATING_ROLES.test(role) && isRiskyLabel(name)) return { reason: "this presses a button that may be hard to undo or visible to others", about: name };
          if (ACTIVATING_ROLES.test(role) && agrees) return { reason: "this answers a dialog, and Ember can't be sure what it agrees to", about: asks, note };
          if (!r.element) return { reason: "Ember can't tell what this key will activate", note: "I can't tell what it will activate." };
          return null;
        }
        if (MNEMONIC_KEY.test(k)) return { reason: "this shortcut presses whichever button has that letter, and Ember can't tell which" };
        // In an open menu a plain letter picks the item with that underlined letter.
        if (/menu/.test(role) && /^(shift\+)?[a-z0-9]$/.test(k)) return { reason: "in an open menu a letter picks whichever item has that letter, and Ember can't tell which" };
        // Any other shortcut with Ctrl or Alt: unknown to Ember unless it only moves, edits or saves.
        if (/(^|\+)(ctrl|alt)\+/.test(k) && !SAFE_COMBOS.has(k)) return { reason: "Ember can't tell what this shortcut does in this app" };
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Moving data between apps (PLAN.md §5): once the task has read another app, what it types, chooses or pastes
   * here may carry that app's text (a page told it to copy an email into a form), so it is asked about every time.
   */
  private withCarried(r: ActionRequest, risk: Risk | null): Risk | null {
    const here = r.app.trim().toLowerCase();
    const others = [...new Set((r.readFrom ?? []).map(a => a.trim()).filter(a => a && a.toLowerCase() !== here))];
    if (!others.length) return risk;
    const pastes = r.kind === "keys" ? PASTE_KEYS.has(keyFamily(canonicalKeys(r.value ?? "") ?? ""))
      : (r.kind === "click" || r.kind === "cursor_click") && PASTE_LABEL.test(plainText(r.element?.name ?? ""));
    if (!pastes && !["text", "cursor_text", "select", "value"].includes(r.kind)) return risk;
    const from = appList(others.slice(0, 3));
    const note = `I read ${from} in this task, so this may carry text from there.`;
    return { reason: risk?.reason ?? `this may carry text from ${from} into ${r.app || "this app"}`, about: risk?.about, note: risk?.note ? `${risk.note} ${note}` : note };
  }

  private decideBase(r: ActionRequest, count = true): Decision {
    const plain = describe(r);
    const win = { app: r.app, name: r.window };
    const never = (reason: string): Decision => ({ tier: "never", verdict: "deny", reason, prompt: plain });

    if ((r.app || r.window) && isNeverLook(win, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (r.kind === "open_app" && r.value && isNeverLook({ app: r.value, name: r.value }, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (isSecurityWindow({ app: r.app, title: r.window })) return never("authentication and security windows are for the user only");
    if (r.element?.role === "password text") return never("password fields are for the user only");
    if (r.element?.role === "terminal") return never("Ember doesn't run commands, so it never types into terminals");
    if (r.kind === "open_app" && this.o.isTerminalApp?.(r.app || r.value || "")) return never("Ember doesn't run commands, so it never opens terminals");
    // Not their menus or settings either: Paste puts the clipboard into the shell, a profile's command runs.
    if (r.kind !== "read" && r.app && this.o.isTerminalApp?.(r.app)) return never("Ember doesn't run commands, so it never acts in terminals or apps with a shell built in");
    if (r.kind !== "read" && r.element && runsProgram(r.element.role, r.element.name, r.dialog)) {
      return never("Ember doesn't run programs, so it never makes files executable or runs them");
    }
    if ((r.kind === "text" || r.kind === "cursor_text" || r.kind === "select" || r.kind === "value" || r.kind === "keys") && r.element && (r.element.secret || isSecretField(r.element.name))) {
      return never("this looks like a password or payment field");
    }
    if (r.kind === "keys") {
      const k = canonicalKeys(r.value ?? "");
      if (!k) return never("Ember's keyboard doesn't know that key combination");
      if (isSystemKey(k)) return never("desktop shortcuts (the logo key, terminals, the run dialog, switching sessions) and Ember's own shortcuts are for the user only");
    }

    if (r.kind === "read") return { tier: "read", verdict: "allow", reason: "reading is allowed", prompt: plain };
    if (this.o.actionsAllowed && !this.o.actionsAllowed()) return never("your organisation has turned off Ember acting in apps");

    if (count && !this.withinRate(r.taskId)) return { tier: "confirm", verdict: "deny", reason: "too many actions in a minute; slow down and check the result", prompt: plain };

    const risk = this.withCarried(r, this.riskOf(r));
    const prompt = risk?.note ? `${plain} ${risk.note}` : plain;
    if (r.onDesk) {
      // Ember's desk: its own display and app instances, so mouse and keyboard need no borrowing.
      // Hard-to-undo actions are still confirmed (desk apps share the user's files).
      if (risk) return { tier: "confirm", verdict: "confirm", reason: risk.reason, about: risk.about, prompt: `${plain.replace(/\?$/, "")} (on my desk)?${risk.note ? ` ${risk.note}` : ""}`, risky: true, everyTime: true };
      return { tier: "reversible", verdict: "allow", reason: "on Ember's desk", prompt };
    }

    // Anything with the borrowed mouse or keyboard is confirmed every time (PLAN.md §5).
    if (r.kind === "cursor_click" || r.kind === "cursor_text" || r.kind === "keys" || r.kind === "scroll") {
      return { tier: "confirm", verdict: "confirm", reason: risk?.reason ?? "Ember needs your mouse or keyboard for this", about: risk?.about, prompt, risky: true, everyTime: true };
    }

    // Launching apps and Ember's short list of comfort settings are easy to undo.
    if (r.kind === "open_app" || r.kind === "setting") return { tier: "reversible", verdict: "allow", reason: "easy to undo", prompt };

    const grant = this.o.grants()[r.app.toLowerCase()];
    if (risk) return { tier: "confirm", verdict: "confirm", reason: risk.reason, about: risk.about, prompt, needsGrant: grant !== "act", risky: true };
    if (grant === "act") return { tier: "reversible", verdict: "allow", reason: `Ember may act in ${r.app}`, prompt };
    return {
      tier: "reversible", verdict: "confirm", reason: `first action in ${r.app || "this app"}`,
      prompt: `Let me work in ${r.app || "this app"}? First step: ${lowerFirst(describe(r, false)).replace(/\?$/, ".")}`,
      needsGrant: true,
    };
  }

  private withinRate(taskId: string): boolean {
    const now = (this.o.now ?? Date.now)();
    const list = (this.recent.get(taskId) ?? []).filter(t => now - t < 60_000);
    list.push(now);
    this.recent.set(taskId, list);
    return list.length <= (this.o.rateLimit ?? 40);
  }
}
