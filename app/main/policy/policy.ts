/**
 * The policy engine: every action a worker wants to take is described as a
 * structured ActionRequest and decided here, never by the model. Tiers follow
 * PLAN.md §5: read and reversible actions run automatically, risky ones need
 * the user's click, and some are never done by Ember at all.
 *
 * Labels come from the screen, so they are normalised before matching:
 * look-alike letters, invisible characters and typographic apostrophes can't
 * hide a "Delete" from the risky-word check.
 *
 * Keys are read with the OS's key conventions (KEYS in app/shared/shortcuts.ts:
 * "mod" is Ctrl on Linux and Windows, Cmd on macOS) and windows with its
 * vocabulary (./vocabulary.ts). Every default is Linux's, so a caller that
 * passes neither gets exactly the answers it got before the port.
 */

import { isNeverLook, isSecretLabel, isSheetCell } from "../perception/elements";
import { parseCombo } from "../hands/borrow";
import { friendlyApp } from "../../shared/apps";
import { roleWord } from "../../shared/role-words";
import { KEYS, SHORTCUTS, type KeyConventions, type OS } from "../../shared/shortcuts";
import { OFFICE_APP, OPENS_PROGRAMS, READ_ONLY_WINDOW, RISKY_EXTRA, RUN_ANSWER_EXTRA, RUN_FILE_DIALOG_EXTRA, RUNS_PROGRAM_EXTRA, SECURITY_APP, SECURITY_CLASS, SECURITY_TITLE, SETTINGS_APP, TABBED_APP, TYPING_REFUSED, WEB_APP, placeName, type OpensPrograms, type TypingRefusal } from "./vocabulary";
import { isRemoteSurface, REMOTE_SURFACE_REASON } from "./remote-surface";
import { targetRules } from "./target-rules";

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
  /**
   * `name` is the element's own name, or else the label beside it; `secret`: the screen reader judged its contents secret;
   * `withheld`: it withheld the element's name (it may say what a secret field holds), so what it says can't be shown.
   */
  element?: { role: string; name: string; secret?: boolean; withheld?: boolean };
  /**
   * Where an element without a name is, for the question only (never judged): the named control it sits in ("Save"
   * push button), or its place in the window ("top right").
   */
  place?: { role: string; name: string } | { at: string };
  /** For text: what will be typed; for settings: the new value; for keys: the combination. */
  value?: string;
  /** For text: replace everything, insert at the caret, or append. */
  mode?: TextMode;
  /**
   * For text and keys: what the field holds now (replacing a lot of it is confirmed; text added to it is judged with
   * what is around it there).
   */
  currentText?: string;
  /**
   * For text added to a field ("append", "insert") and keys that type: what this task typed into this field before,
   * followed by what this one types (checked as one text: a field filled in pieces is judged as a whole).
   */
  typed?: string;
  /**
   * For text and keys: what this task typed into this window's fields before, in order (another field's on a line of
   * its own), followed by what this one types: a number or an address typed into several fields is judged as one text too.
   */
  typedHere?: string;
  /** For keys: Ctrl+A was pressed here (and nothing has moved the caret since), so this one may replace everything selected. */
  afterSelectAll?: boolean;
  /** For keys: text was selected here with Shift and a movement key (Ctrl+Shift+End…): how much, `selection` says when it is known. */
  afterSelecting?: boolean;
  /**
   * For keys: the text selected in the focused field now, as the screen reader tells it ("" when nothing is; undefined
   * when it can't tell): a key that types replaces it. In a paragraph it is only the part in that paragraph.
   */
  selection?: string;
  /**
   * For keys: text may be selected beyond what the focused element tells: "selected" when the focused paragraph (or
   * another one) says it is selected (Edit ▸ Select All in Writer), "unknown" when nothing says it has the keyboard in a
   * window with an editable document (a page's plain editable text).
   */
  selectionBeyond?: "selected" | "unknown";
  /**
   * Text going into a spreadsheet's cell where the element doesn't say so (what edits the cell, Calc's input line), and
   * keys into one: what the cell will hold, symbols too (for keys, what it holds so far followed by what this key types:
   * a formula typed key by key is judged as one, as type_text's is).
   */
  formula?: string;
  /**
   * The dialog the element sits in (its title and text, and whether it is a message box: `alert`): "OK" there agrees
   * to what the dialog says.
   */
  dialog?: { name: string; text: string; alert?: boolean };
  /** For keys: the focused element is in a web page (Chromium's, Firefox's or an Electron app's), where Enter can send. */
  inPage?: boolean;
  /**
   * For text and keys: what the field holds now is only what this task typed there (replacing it, however long, takes
   * nothing of the user's).
   */
  ownText?: boolean;
  /**
   * For a click on a row, cell, icon or list item: the click only selects it (a list's row selected by accessibility, or
   * one with no action of its own, clicked with the mouse), where a mail's subject or a file's name is judged gently
   * (riskyContent). Without it the item does something of its own (a page's list item with a click handler, an option).
   */
  clickSelects?: boolean;
  /** For keys: the focused element takes several lines (a text editor's text: there Enter starts a new line). */
  multiLine?: boolean;
  /** On Ember's own desk (its private display): no app grant needed, full input allowed. */
  onDesk?: boolean;
  /** What the user asked for, in their own words (for the task-alignment check). */
  goal?: string;
  /**
   * Ember's questions the user answered with a yes or a choice ("I can delete the old installers. Shall I?" "Sure."): a
   * risky step one of them names isn't flagged as unasked, but it is asked about all the same. Never part of `goal`.
   */
  agreed?: Agreement[];
  /** The window acted in, as perception names it, when known. */
  windowId?: WindowId;
  /** Windows this task has read (or seen listed): text typed or pasted into another window may carry what was read there. */
  readFrom?: ReadSource[];
}

/** A question of Ember's (`asked`: what the user saw it ask) and the user's reply to it (`answer`), a yes or a choice. */
export interface Agreement { asked: string; answer: string }

/** A window by its process and accessible path (with the pid, they name one window whatever its title), and its role. */
export interface WindowId { pid?: number | null; path?: string; role?: string }

/**
 * A window a task has read: its app, its title then, and the text read there (bounded). `listed`: only its title
 * was seen (list_windows); `described`: what Ember's conversation read on the user's screen (no window known).
 */
export interface ReadSource extends WindowId { app: string; window: string; text?: string; listed?: boolean; described?: boolean }

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
  /** A risky action named only in a question of Ember's the user answered (`agreed`): asked, saying so, not flagged. */
  agreed?: boolean;
  /** Ask every time: an earlier "Allow" in this task doesn't cover it. */
  everyTime?: boolean;
  /** The on-screen words that make it risky (checked against what the user asked for). */
  about?: string;
  /** For the first action in an app: the question about the step alone (the app may be allowed for this task already). */
  stepPrompt?: string;
  /**
   * The whole of the text a task types, when the question shows only its two ends (over 160 characters): the user
   * approves all of it, so the card can show it on request. Cleaned as the question's quotes are.
   */
  detail?: string;
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
  /** Ember's own process (default: this one): a task never acts in Ember's own windows. */
  ownPid?: number;
  /** How keys are named and which are the OS's own (default KEYS.linux): "cmd+s" is a shortcut on macOS, the logo key on Linux. */
  keys?: KeyConventions;
  /** Which OS's vocabulary judges windows and labels (default "linux"). */
  os?: OS;
  /** Is this window an authentication or security prompt (default: isSecurityWindow with `os`)? */
  isSecurityWindow?: (w: { app?: string; title?: string; name?: string }) => boolean;
}

/** Latin look-alikes from Cyrillic and Greek, enough to keep "Dеlete" (Cyrillic е) from passing as harmless. */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w", "ү": "y", "һ": "h",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
};

/**
 * Characters that show nothing: format characters, the soft hyphen, and the blank "letters" (Hangul fillers, the
 * braille blank, Khmer's invisible vowels, the combining grapheme joiner) that would split a word or a number unseen.
 */
const INVISIBLE = /[\p{Cf}\u00ad\u115f\u1160\u180e\u2800\u3164\uffa0]|\u034f|\u17b4|\u17b5|\u180b|\u180c|\u180d|\u180f/gu;

/** What a label says, ready for matching: compatibility forms folded, invisible characters gone, look-alikes mapped. */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/[\u2019\u02bc\u2018`\u00b4]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase()
    .replace(/[\u0080-\uffff]/g, c => CONFUSABLES[c] ?? c);
}

/** Words on buttons that make an action hard to undo or visible to others. */
const RISKY = /\b(send|post|submit|publish|share|delete|remove|erase|discard|overwrite|replace|empty|buy|pay|order|purchase|checkout|install|uninstall|upload|transfer|reply|forward|sign(?! ?(in|on)\b)|accept|approve|confirm|authori[sz]e|grant|trust|merge|run|execute|reset|clear|archive|revoke|unsubscribe|trash|wipe|destroy|quit|close without saving|don't save|log ?out|sign ?out|shut ?down|restart|reboot|power off|kill|terminate|end process|force stop|donate|book now|deploy|subscribe|leave (the |this )?(group|chat|conversation|meeting|team|channel))\b/;

/**
 * Text in other languages, ready for matching: compatibility forms folded, invisible characters and
 * accents gone ("Löschen" and "Loschen" alike), Cyrillic left as it is (no look-alike folding here).
 */
export function foldLabel(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE, "").replace(/[’ʼ‘`]/g, "'").toLowerCase()
    .normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC").replace(/\s+/g, " ");
}

/**
 * The same in the languages RHEL desktops commonly use: infinitives and imperatives (the forms buttons
 * use) for deleting, removing, emptying, sending, submitting, replying, forwarding, sharing, publishing,
 * buying, ordering, paying, transferring money, installing, resetting, signing out, confirming,
 * accepting, discarding, closing without saving, replacing and overwriting, merging, quitting, running programs, moving to
 * the trash, archiving, restarting, subscribing, signing and uploading (GTK's and Nautilus's own words where they have them).
 * Whole words only; words that are also everyday labels ("Formato", "Zahlen", "Ordina" = sort, "Firma") are left out, and
 * formatting is risky only for a disk (FORMAT_WORDS).
 * Written with their accents (folded when the pattern is built).
 */
export const RISKY_WORDS: Record<string, string[]> = {
  fr: ["supprimer", "supprimez", "supprime", "suppression", "effacer", "effacez", "efface", "retirer", "retirez", "enlever", "enlevez",
    "vider", "videz", "envoyer", "envoyez", "envoie", "soumettre", "soumettez", "valider", "validez", "répondre", "répondez",
    "transférer", "transférez", "partager", "partagez", "publier", "publiez", "commander", "commandez", "passer (la )?commande",
    "acheter", "achetez", "payer", "payez", "installer", "installez", "désinstaller", "désinstallez", "réinitialiser", "réinitialisez",
    "déconnecter", "déconnexion", "confirmer", "confirmez", "accepter", "acceptez", "accepte",
    "ne pas enregistrer", "sans enregistrer", "quitter", "exécuter", "exécutez", "lancer", "lancez",
    "(mettre|déplacer|jeter) (à|dans|vers) la corbeille", "remplacer", "remplacez", "écraser", "écrasez", "fusionner", "archiver",
    "redémarrer", "éteindre", "s'abonner", "se désabonner", "signer", "téléverser"],
  de: ["löschen", "lösche", "loeschen", "entfernen", "entferne", "leeren", "senden", "sende", "absenden", "versenden", "abschicken",
    "verschicken", "einreichen", "übermitteln", "antworten", "antworte", "weiterleiten", "teilen", "freigeben", "veröffentlichen",
    "kaufen", "bestellen", "bestelle", "zahlungspflichtig", "bezahlen", "jetzt zahlen", "überweisen", "überweisung", "installieren",
    "deinstallieren", "zurücksetzen", "abmelden", "ausloggen", "bestätigen", "akzeptieren", "annehmen", "zustimmen",
    "verwerfen", "nicht speichern", "ohne speichern", "beenden", "ausführen", "in den papierkorb", "ersetzen", "ersetze", "überschreiben",
    "zusammenführen", "ohne zu speichern", "archivieren", "neu starten", "herunterfahren", "abonnieren", "abbestellen", "unterschreiben",
    "signieren", "hochladen"],
  es: ["eliminar", "elimina", "elimine", "borrar", "borra", "borre", "suprimir", "suprime", "suprima", "quitar", "quita", "quite",
    "vaciar", "enviar", "envía", "envíe", "responder", "responde", "responda", "reenviar", "reenvía", "compartir", "comparte",
    "comparta", "publicar", "publique", "comprar", "compra", "compre", "(realizar|hacer|tramitar|finalizar) pedido", "pagar", "paga",
    "pague", "transferir", "transfiere", "instalar", "instala", "instale", "desinstalar", "restablecer", "restablece",
    "cerrar sesión", "desconectar", "confirmar", "confirma", "confirme", "aceptar", "acepta", "acepte", "acepto", "descartar",
    "descarta", "no guardar", "sin guardar", "salir", "ejecutar", "ejecuta", "ejecute", "ejecutarlo", "ejecutarlos",
    "(mover|tirar) a la papelera", "reemplazar", "reemplaza", "reemplace", "reemplazarlo", "sustituir", "sobrescribir", "sobreescribir",
    "mezclar", "fusionar", "archivar", "reiniciar", "apagar", "suscribirse", "darse de baja", "firmar", "subir"],
  it: ["eliminare", "elimina", "elimini", "cancellare", "cancella", "rimuovere", "rimuovi", "svuotare", "svuota", "inviare", "invia",
    "spedire", "spedisci", "rispondere", "rispondi", "inoltrare", "inoltra", "condividere", "condividi", "pubblicare", "pubblica",
    "acquistare", "acquista", "comprare", "ordina ora", "effettua (l')?ordine", "pagare", "paga", "bonifico", "installare", "installa",
    "disinstallare", "disinstalla", "reimpostare", "reimposta", "disconnetti", "esci", "confermare",
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
    "opnieuw instellen", "afmelden", "uitloggen", "bevestigen", "bevestig", "accepteren", "accepteer", "akkoord",
    "niet opslaan", "verwerpen", "afsluiten", "vervangen", "vervang", "overschrijven", "zonder opslaan", "naar (de )?prullenbak",
    "samenvoegen"],
  pl: ["usuń", "usunąć", "skasuj", "opróżnij", "wyślij", "wysłać", "odpowiedz", "przekaż", "udostępnij", "opublikuj", "kup",
    "kupuję", "zamów", "zamawiam", "zapłać", "płacę", "przelew", "zainstaluj", "odinstaluj", "resetuj", "zresetuj",
    "wyloguj", "potwierdź", "zatwierdź", "akceptuj", "zaakceptuj", "zgadzam się", "odrzuć", "nie zapisuj", "zastąp", "zastąpić",
    "nadpisz", "nadpisać", "bez zapisywania", "do kosza", "scal"],
  ru: ["удалить", "удали", "удалите", "убрать", "очистить", "очисти", "отправить", "отправь", "отправьте", "послать", "ответить",
    "ответь", "ответьте", "переслать", "перешли", "поделиться", "поделись", "опубликовать", "опубликуй", "купить", "купи",
    "оформить заказ", "заказать", "закажи", "оплатить", "оплати", "заплатить", "установить", "установи", "сбросить", "сбрось",
    "выйти", "выход", "подтвердить", "подтверди", "подтвердите", "принять", "прими", "согласен", "согласиться",
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
    "zveřejnit", "koupit", "objednat", "zaplatit", "nainstalovat", "instalovat", "odinstalovat", "resetovat",
    "odhlásit", "potvrdit", "přijmout", "souhlasím", "neukládat", "nahradit", "přepsat", "bez uložení", "do koše"],
  tr: ["sil", "kaldır", "boşalt", "gönder", "yanıtla", "cevapla", "ilet", "paylaş", "yayınla", "satın al", "sipariş ver", "ödeme yap",
    "ödemeyi tamamla", "havale", "yükle", "sıfırla", "çıkış yap", "oturumu kapat", "onayla", "kabul et",
    "kabul ediyorum", "kaydetme", "üzerine yaz", "kaydetmeden", "çöpe taşı"],
};
/** Scripts without spaces between words: matched anywhere in the label. */
export const RISKY_ANYWHERE: Record<string, string[]> = {
  ja: ["削除", "消去", "送信", "返信", "転送", "共有", "公開", "投稿", "購入", "注文", "決済", "支払", "振込", "送金", "インストール",
    "リセット", "初期化", "ログアウト", "サインアウト", "確定", "同意", "承認", "破棄", "保存しない", "空にする", "終了", "置き換え", "置換", "上書き", "保存せず", "ゴミ箱"],
  zh: ["删除", "刪除", "移除", "清空", "清除", "发送", "發送", "提交", "回复", "回覆", "转发", "轉發", "分享", "共享", "发布", "發佈",
    "發布", "发表", "發表", "购买", "購買", "下单", "下單", "结算", "結算", "支付", "付款", "转账", "轉帳", "汇款", "匯款", "安装",
    "安裝", "卸载", "卸載", "重置", "注销", "註銷", "登出", "退出", "同意", "接受", "放弃", "放棄", "不保存", "替换", "替換", "覆盖", "覆蓋", "回收站", "废纸篓", "廢紙簍"],
  ko: ["삭제", "제거", "비우기", "전송", "보내기", "제출", "답장", "전달", "공유", "게시", "구매", "구입", "주문", "결제", "이체",
    "송금", "설치", "초기화", "로그아웃", "동의", "수락", "저장 안 함", "종료", "모두 바꾸기", "찾아 바꾸기", "덮어쓰기", "저장하지 않", "휴지통"],
};
const all = (lists: Record<string, string[]>) => foldLabel(Object.values(lists).flat().join("|"));
const intlSource = (words: Record<string, string[]>, anywhere: Record<string, string[]>) =>
  `(^|[^\\p{L}\\p{N}])(?<word>${all(words)})(?=$|[^\\p{L}\\p{N}])|(?<cjk>${all(anywhere)})`;
const RISKY_INTL_SOURCE = intlSource(RISKY_WORDS, RISKY_ANYWHERE);
const RISKY_INTL = new RegExp(RISKY_INTL_SOURCE, "u");

/**
 * Words on controls that post or answer for the user, invite or act on other people, change their account, or
 * change a shared repository. Risky on a button, link or menu item, and on anything clicked but a check box, radio
 * button or switch (a click on text goes to the link or row around it): a "Block selection" check item, or a "Comments"
 * heading a key lands on, isn't one. English verbs that are nouns too count where they lead the label
 * ("Report", "Block user"; not "Download report", "Add block").
 */
const RISKY_ACT_LEAD = /^[^\p{L}\p{N}]*(comment|invite|decline|withdraw|deactivate|push(?! notifications?\b)|revert|commit|tweet|retweet|repost|reblog|block|unfriend|report|ban|kick|forget)\b/u;
const RISKY_ACT = /\b(add (a )?comment|cancel (my |your |the |this )?(subscription|membership|account|plan|trial|booking|reservation)|(close|deactivate) (my |your |the |this )?account|close (the |this )?(issue|pull request|merge request)|(create|open) (a |the )?(pull|merge) request|request (a )?review|request changes|force push|go live|start (the |a )?(broadcast|stream|livestream|live stream)|refresh (firefox|chrome|chromium|(the |your )?browser))\b/;
/** The same in the languages of RISKY_WORDS (written with their accents, folded when the pattern is built). */
export const RISKY_ACT_WORDS: Record<string, string[]> = {
  fr: ["commenter", "commentez", "inviter", "invitez", "refuser", "refusez", "décliner", "résilier", "annuler (l'|mon |votre )?abonnement",
    "fermer (le |mon |votre )?compte", "désactiver (le |mon |votre )?compte", "créer (une )?(pull|merge) request", "créer une demande de (fusion|tirage)",
    "demander (une )?(revue|relecture)", "pousser", "tweeter", "retweeter", "reposter", "republier", "passer en direct", "lancer (le )?direct",
    "bloquer", "signaler", "bannir", "expulser", "oublier", "réparer firefox"],
  de: ["kommentieren", "einladen", "ablehnen", "zurückziehen", "kündigen", "konto schließen", "konto deaktivieren", "pull request erstellen",
    "merge request erstellen", "review anfordern", "überprüfung anfordern", "pushen", "committen", "twittern", "tweeten", "retweeten", "reposten",
    "live gehen", "blockieren", "melden", "bannen", "verbannen", "verbindung vergessen", "netzwerk vergessen", "gerät vergessen",
    "diese website vergessen", "firefox bereinigen"],
  es: ["comentar", "comenta", "invitar", "invita", "rechazar", "rechaza", "declinar", "retirar", "retira", "cancelar (la |mi |tu |su )?suscripción",
    "cerrar (la |mi |tu |su )?cuenta", "desactivar (la |mi |tu |su )?cuenta", "crear (una )?(pull|merge) request",
    "crear (una )?solicitud de (extracción|incorporación|fusión|cambios)", "solicitar (una )?revisión", "hacer push", "revertir", "tuitear", "retuitear",
    "republicar", "repostear", "transmitir en (vivo|directo)", "bloquear", "denunciar", "reportar", "banear", "expulsar", "olvidar"],
  it: ["commenta", "commentare", "invita", "invitare", "rifiuta", "rifiutare", "declina", "ritira", "ritirare", "annulla (l')?abbonamento", "disdici",
    "chiudi (l')?account", "disattiva (l')?account", "crea (una )?(pull|merge) request", "richiedi (una )?revisione", "twitta", "ritwitta", "ripubblica",
    "vai in diretta", "avvia (la )?diretta", "blocca", "segnala", "banna", "espelli", "dimentica", "ripristina firefox"],
  pt: ["comentar", "comente", "convidar", "convide", "recusar", "recuse", "declinar", "retirar", "cancelar (a |minha |sua )?(assinatura|inscrição)",
    "(encerrar|fechar) (a |minha |sua )?conta", "desativar (a |minha |sua )?conta", "criar (uma )?(pull|merge) request",
    "criar (uma )?solicitação de (pull|merge|mesclagem)", "solicitar (uma )?revisão", "fazer push", "reverter", "tuitar", "retuitar", "republicar",
    "repostar", "transmitir ao vivo", "bloquear", "denunciar", "reportar", "banir", "expulsar", "esquecer", "restaurar o firefox"],
  nl: ["reageren", "uitnodigen", "nodig uit", "afwijzen", "weigeren", "terugtrekken", "intrekken", "opzeggen", "account (sluiten|opheffen|deactiveren)",
    "pull request aanmaken", "merge request aanmaken", "review aanvragen", "pushen", "terugdraaien", "tweeten", "retweeten", "reposten", "live gaan",
    "blokkeren", "rapporteren", "melden", "verbannen", "verbinding vergeten", "netwerk vergeten", "deze website vergeten", "firefox opfrissen"],
  pl: ["skomentuj", "komentuj", "zaproś", "odmów", "wycofaj", "anuluj subskrypcję", "zamknij konto", "dezaktywuj", "utwórz (pull|merge) request",
    "poproś o recenzję", "wypchnij", "tweetuj", "podaj dalej", "rozpocznij transmisję", "transmisja na żywo", "zablokuj", "zgłoś", "zbanuj", "wyrzuć", "zapomnij",
    "odśwież (program )?firefox"],
  ru: ["комментировать", "прокомментировать", "пригласить", "пригласи", "отклонить", "отклони", "отказаться", "отозвать", "вывести средства",
    "отменить подписку", "отписаться", "закрыть аккаунт", "деактивировать", "создать (pull|merge) request", "создать запрос на (слияние|включение)",
    "запросить (ревью|проверку)", "запушить", "откатить", "твитнуть", "ретвитнуть", "репост", "сделать репост", "начать трансляцию", "выйти в эфир",
    "заблокировать", "заблокируй", "пожаловаться", "забанить", "выгнать", "забыть"],
  sv: ["kommentera", "bjud in", "avböj", "neka", "dra tillbaka", "säg upp", "avsluta prenumeration(en)?", "(avsluta|stäng|inaktivera) (mitt |ditt )?konto",
    "skapa pull request", "begär granskning", "pusha", "tweeta", "retweeta", "gå live", "blockera", "rapportera", "anmäl", "bannlys", "glöm"],
  da: ["kommenter", "inviter", "invitér", "afvis", "afslå", "træk tilbage", "opsig", "(luk|deaktiver) (min |din )?konto", "opret pull request",
    "anmod om gennemgang", "gå live", "bloker", "rapporter", "anmeld", "udeluk", "glem"],
  nb: ["kommenter", "inviter", "avslå", "trekk tilbake", "si opp", "avslutt abonnement(et)?", "(avslutt|lukk|deaktiver) (min |din )?konto",
    "opprett pull request", "be om gjennomgang", "gå live", "blokker", "rapporter", "anmeld", "utesteng", "glem"],
  fi: ["kommentoi", "kutsu", "hylkää", "kieltäydy", "peruuta tilaus", "peru tilaus", "sulje tili", "poista tili käytöstä", "luo pull request",
    "pyydä (arviointia|katselmointia)", "twiittaa", "aloita lähetys", "estä", "ilmianna", "raportoi", "anna porttikielto", "unohda"],
  cs: ["komentovat", "okomentovat", "pozvat", "odmítnout", "zamítnout", "zrušit (předplatné|odběr|účet)", "zavřít účet", "deaktivovat účet",
    "vytvořit (pull|merge) request", "požádat o revizi", "pushnout", "vrátit změny", "tweetnout", "retweetnout", "zahájit vysílání", "vysílat živě",
    "zablokovat", "blokovat", "nahlásit", "zabanovat", "vyhodit", "zapomenout", "zapomeň", "vyčistit firefox"],
  tr: ["yorum yap", "yorumla", "davet et", "reddet", "geri çek", "(aboneliği|aboneliğimi|üyeliği|üyeliğimi) iptal et", "(hesabı|hesabımı) kapat",
    "(hesabı|hesabımı) devre dışı bırak", "pull request oluştur", "birleştirme isteği oluştur", "inceleme iste", "tweetle", "retweetle",
    "yeniden paylaş", "canlı yayına geç", "canlı yayın başlat", "engelle", "şikayet et", "bildir", "yasakla", "unut", "firefox'u yenile"],
};
/** Scripts without spaces between words: matched anywhere in the label. */
export const RISKY_ACT_ANYWHERE: Record<string, string[]> = {
  ja: ["コメント", "招待", "辞退", "拒否", "取り下げ", "解約", "退会", "アカウント停止", "アカウントを停止", "プルリクエスト", "マージリクエスト",
    "レビューを依頼", "レビュー依頼", "プッシュ", "リバート", "コミット", "ツイート", "リツイート", "リポスト", "ライブ配信", "配信開始", "ブロック", "通報",
    "追放", "キック"],
  zh: ["评论", "評論", "留言", "邀请", "邀請", "拒绝", "拒絕", "谢绝", "謝絕", "撤回", "提现", "提現", "取消订阅", "取消訂閱", "退订", "退訂",
    "关闭账户", "關閉帳戶", "关闭账号", "停用账户", "停用帳戶", "停用账号", "拉取请求", "拉取要求", "合并请求", "合併請求", "请求审查", "請求審查",
    "请求评审", "推送", "回滚", "回滾", "转推", "轉推", "转帖", "轉帖", "开始直播", "開始直播", "拉黑", "屏蔽", "封锁", "封鎖", "举报", "舉報", "檢舉", "封禁", "踢出"],
  ko: ["댓글", "초대", "거절", "거부", "철회", "출금", "구독 취소", "구독 해지", "해지", "탈퇴", "계정 비활성화", "풀 리퀘스트", "머지 리퀘스트",
    "리뷰 요청", "검토 요청", "푸시", "커밋", "트윗", "리트윗", "재게시", "라이브 시작", "방송 시작", "차단", "신고", "추방", "강퇴"],
};
const RISKY_ACT_INTL_SOURCE = intlSource(RISKY_ACT_WORDS, RISKY_ACT_ANYWHERE);
const RISKY_ACT_INTL = new RegExp(RISKY_ACT_INTL_SOURCE, "u");
/** Does this label post, invite, change an account or a repository (RISKY_ACT), in any of the languages above? */
const isRiskyActLabel = (s: string) => { const n = normalizeLabel(s); return RISKY_ACT_LEAD.test(n) || RISKY_ACT.test(n) || RISKY_ACT_INTL.test(foldLabel(s)); };
/** Controls whose activation does what their name says (HTML buttons and links, GTK buttons, menu items). */
const ACTING_CONTROL = /^(push button|push button menu|button|split button|toggle button|link|menu item)$/;

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
/** A button that is only "Confirm" or "Approve": it agrees to what is asked, as "OK" does. */
const LONE_AGREE = /^\s*(yes,?\s*)?(confirm|approve)\s*[.!]?\s*$/;
/** Fields Ember never fills: secrets and payment details (an expiry date only beside a card: the screen reader's list has those). */
const SECRET_FIELD = /\b(password|passphrase|passcode|pin|card ?number|credit ?card|cvv|cvc|security code|iban|routing number|account number|one-time code|otp|2fa|recovery code|secret)\b/;
/**
 * Is this an authentication or security prompt (polkit, sudo, keyring…)? Ember stays out of those. By `os`'s
 * vocabulary (./vocabulary.ts): its prompts' programs and titles, and the window classes its backend reports as the
 * app. On Linux GNOME Shell counts too: it draws its own password prompts (polkit, keyring) in its own window, and
 * while it has the keyboard Ember treats it as one (it never acts in the shell anyway).
 */
export function isSecurityWindow(w: { app?: string; title?: string; name?: string }, os: OS = "linux"): boolean {
  const app = (w.app ?? "").trim();
  if (SECURITY_APP[os]?.test(app)) return true;
  if (SECURITY_TITLE[os]?.test(normalizeLabel(w.title ?? w.name ?? ""))) return true;
  return SECURITY_CLASS[os].includes(app.toLowerCase());
}

/**
 * Formatting, in the languages of RISKY_WORDS: risky for a disk only (a label that names one, or "Format…" in a window
 * or dialog about one, as GNOME Disks has them), never LibreOffice's or a mail composer's "Format" menu.
 */
const FORMAT_WORDS = ["format", "formater", "formatez", "formatieren", "formatear", "formattare", "formatta", "formatar", "formate", "formatteren",
  "formatuj", "sformatuj", "форматировать", "отформатировать", "biçimlendir", "formátovat", "naformátovat", "formatera"];
const FORMAT_ANYWHERE = ["フォーマット", "格式化", "포맷"];
/** Disks, drives, partitions and volumes: the start of the word ("Datenträger", "disques", "разделы"). */
const DISK_STEMS = ["disk", "drive", "partition", "volume", "device", "usb", "sd card", "memory card", "file ?system", "media", "flash",
  "datenträger", "laufwerk", "festplatte", "disque", "lecteur", "périphérique", "disco", "dischi", "unidad", "unità", "partic", "partiz", "volum",
  "dispositiv", "schijf", "schijven", "station", "dysk", "partycj", "wolumin", "urządzeni", "диск", "раздел", "том", "устройств", "накопител",
  "bölüm", "birim", "sürücü", "oddíl", "svazek", "svazk", "jednotk", "zařízení"];
const DISK_ANYWHERE = ["ディスク", "ドライブ", "パーティション", "ボリューム", "デバイス", "磁盘", "磁碟", "硬盘", "硬碟", "驱动器", "分区", "分割區", "디스크",
  "드라이브", "파티션", "볼륨", "장치"];
const FORMAT_LABEL = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(FORMAT_WORDS.join("|"))})(?=$|[^\\p{L}\\p{N}])|${foldLabel(FORMAT_ANYWHERE.join("|"))}`, "u");
const DISK_WORD = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(DISK_STEMS.join("|"))})|${foldLabel(DISK_ANYWHERE.join("|"))}`, "u");
/** Does this label format a disk: by its own words, or in a window or dialog about one (`context`)? */
const formatsDisk = (label: string, context = "") => FORMAT_LABEL.test(foldLabel(label)) && DISK_WORD.test(foldLabel(`${label} ${context}`));

/**
 * Words that say a setting guards the user's security or privacy: security, macros, trust, proxies, certificates,
 * passwords, encryption, privacy, permissions, the firewall, remote content, phishing and malware, in the languages of
 * RISKY_WORDS. The start of a word ("Trusted Sources", "Sicherheit", "Zertifikate", "безопасности"), written with
 * accents (folded when the pattern is built).
 */
const SECURITY_STEMS = ["secur", "insecur", "unsafe", "macro", "trust", "untrust", "distrust", "proxy", "proxies", "certificat", "password",
  "passphrase", "passcode", "encrypt", "decrypt", "cryptograph", "privacy", "permission", "firewall", "authenticat", "two-factor", "2fa",
  "remote content", "remote image", "logins", "phishing", "malware", "virus", "scam", "fraud", "deceptive",
  "sicherheit", "unsicher", "makro", "vertrau", "zertifikat", "passwort", "kennwort", "verschlüssel", "datenschutz", "privatsphäre", "berechtigung",
  "confiance", "approuvé", "mandataire", "certificat", "mot de passe", "mots de passe", "chiffr", "confidentialité", "vie privée", "autorisation",
  "pare-feu", "seguridad", "insegur", "confianza", "fiable", "certificad", "contraseña", "cifrad", "privacidad", "permiso", "cortafuegos",
  "sicurezza", "non sicur", "attendibil", "fidat", "crittograf", "cifratur", "riservatezza", "autorizzazion", "permess", "segurança", "confiáve",
  "senha", "palavra-passe", "criptograf", "encripta", "privacidade", "permiss", "beveilig", "veiligheid", "onveilig", "vertrouw", "certifica",
  "wachtwoord", "versleutel", "machtiging", "bezpiecze", "niebezpiecz", "makr", "zaufan", "certyfikat", "hasł", "szyfrow", "prywatn", "uprawnie",
  "zapora", "безопасн", "небезопасн", "макрос", "довер", "прокси", "сертификат", "парол", "шифрован", "конфиденциальн", "разрешени", "брандмауэр",
  "säkerhet", "osäker", "betrodd", "förtroende", "lösenord", "krypter", "sekretess", "behörighet", "brandvägg", "sikkerhed", "sikkerhet",
  "usikker", "betroe", "klarert", "mellomtjener", "sertifikat", "adgangskode", "passord", "kryptering", "privatliv", "personvern", "tilladelse",
  "tillatelse", "brannmur", "suojaus", "tietoturva", "turvaton", "luotet", "välityspalvelin", "varmen", "salasan", "salaus", "yksityisyy",
  "käyttöoikeu", "palomuuri", "zabezpeč", "bezpečnost", "nebezpeč", "důvěryhodn", "certifikát", "hesl", "šifrován", "soukrom", "oprávnění",
  "güvenlik", "güvenliğ", "güvensiz", "güvenilir", "vekil sunucu", "sertifika", "şifre", "gizlilik", "izinler",
  // Authentication, protection, remote content, deception and sharing the screen or files, besides English.
  "authentifi", "autentic", "autentis", "uwierzytelni", "аутентифик", "защит", "externe inhalt", "entfernte inhalt", "contenu distant",
  "contenus distant", "contenido remot", "contenuti remot", "contenuto remot", "conteúdo remot", "externe inhoud", "fjärrinnehåll", "betrüger",
  "trompeu", "ingannevol", "enganos", "misleidend",
  "dangerous", "unwanted software", "uncommon software", "https-only", "safe browsing", "screen shar", "file shar", "remote desktop",
  "remote access", "remote login", "remote control", "control your screen", "bildschirmfreigabe"];
/**
 * The same that are also the end of a word, in the languages that join words ("Verbindungssicherheit", "Hauptpasswort",
 * "Verbindingsbeveiliging", "Anslutningssäkerhet", "Forbindelsessikkerhed", "pääsalasana").
 */
const SECURITY_INSIDE = ["sicherheit", "passwort", "kennwort", "zertifikat", "verschlüssel", "datenschutz", "berechtigung", "beveilig", "wachtwoord",
  "versleutel", "säkerhet", "lösenord", "certifikat", "krypter", "sikkerhed", "sikkerhet", "adgangskode", "passord", "sertifikat", "salasan",
  "tietoturva", "suojaus"];
const SECURITY_ANYWHERE = ["セキュリティ", "マクロ", "信頼", "プロキシ", "証明書", "パスワード", "暗号", "プライバシー", "権限", "ファイアウォール", "安全", "信任",
  "代理", "证书", "證書", "密码", "密碼", "加密", "隐私", "隱私", "权限", "權限", "防火墙", "防火牆", "보안", "매크로", "신뢰", "프록시", "인증서", "암호",
  "비밀번호", "개인 정보", "권한", "방화벽", "保護", "認証", "保护", "验证", "인증", ...SECURITY_INSIDE];
const SECURITY_WORD = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(SECURITY_STEMS.join("|"))})|${foldLabel(SECURITY_ANYWHERE.join("|"))}`, "u");
/**
 * A setting that says it weakens a protection: "Low (not recommended)", "Allow all", "Never ask", "Disable phishing
 * protection", and "not recommended" in the languages of RISKY_WORDS.
 */
const WEAKENS = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(["not recommended", "unsafe", "insecure", "unsecured?", "allow all", "trust all", "accept all",
  "without (asking|confirmation|confirming|warning|warnings|prompting|a warning)", "(don't|do not|never) (ask|warn|prompt|confirm)",
  "(disable|turn off|switch off|deactivate|bypass|skip)\\b.{0,40}\\b(protection|security|warnings?|checks?|checking|verification|sandbox|blocking|safe browsing)",
  "nicht empfohlen", "non recommandée?", "déconseillée?", "no recomendad[oa]", "sconsigliat[oa]", "non consigliat[oa]", "não recomendad[oa]",
  "niet aanbevolen", "niezalecane", "nie zalecane", "не рекомендуется", "rekommenderas inte", "anbefales ikke", "ei suositella", "nedoporučen[oéa]",
  "nedoporučuje se", "önerilmez", "tavsiye edilmez"].join("|"))})(?=$|[^\\p{L}\\p{N}])|${foldLabel(["推奨されません", "非推奨", "不推荐", "不推薦", "不建议",
  "不建議", "권장하지 않"].join("|"))}`, "u");
/** Does `s` say so, as written (Cyrillic stays Cyrillic) or with look-alikes mapped ("Pаssword" with a Cyrillic а)? */
const saysWord = (re: RegExp, s: string) => re.test(foldLabel(s)) || re.test(foldLabel(normalizeLabel(s)));
/** Is this about the user's security or privacy (SECURITY_WORD)? */
const securityTalk = (s: string) => saysWord(SECURITY_WORD, s);
/** Does this setting say it weakens a protection, or is it about security (a setting of Macro Security, a proxy's)? */
const securitySetting = (s: string) => saysWord(WEAKENS, s) || securityTalk(s);

/** Words risky only as the whole label: Korean "바꾸기" is GTK's Replace button, but also part of "이름 바꾸기" (Rename). */
const RISKY_WHOLE = new RegExp(`^\\s*(${foldLabel(["바꾸기"].join("|"))})\\s*([(（][^)）]*[)）])?\\s*$`, "u");
/** One value per OS, made the first time that OS asks (the vocabularies and key tables are fixed for a run). */
function perOS<T>(make: (os: OS) => T): (os: OS) => T {
  const made = new Map<OS, T>();
  return os => {
    if (!made.has(os)) made.set(os, make(os));
    return made.get(os)!;
  };
}
/** Whole words or phrases (regular-expression source), or null for none. */
const wordsOf = (list: readonly string[]) => (list.length ? new RegExp(`\\b(${list.join("|")})\\b`) : null);
/** RISKY_EXTRA[os] (the OS's own words for what can't be undone), as one expression. */
const riskyExtra = perOS(os => wordsOf(RISKY_EXTRA[os]));
/** Is this label risky (RISKY, the languages' lists, a disk's formatting, and on `os` its own words: RISKY_EXTRA)? */
export const isRiskyLabel = (s: string, os: OS = "linux") => RISKY.test(normalizeLabel(s)) || RISKY_INTL.test(foldLabel(s)) || RISKY_WHOLE.test(foldLabel(s)) || formatsDisk(s)
  || (riskyExtra(os)?.test(normalizeLabel(s)) ?? false);
/** Is activating this control hard to undo or visible to others: a risky label, or one that posts or acts on others (RISKY_ACT) on a button, link or menu item? */
export const isRiskyControl = (role: string, name: string, os: OS = "linux") => isRiskyLabel(name, os) || (ACTING_CONTROL.test(role) && isRiskyActLabel(name));

/** Ember's own windows by app or title (settings, the overlay and its bubble, Ask Ember, the desk's view, the microphone helper, the command window). */
const EMBER_WINDOW = /^(ember|ember overlay|ask ember|ember's desk|ember microphone|ember commands)$/;
/**
 * Is this one of Ember's own windows: its process's, an app called Ember, or (when its process isn't known) a window
 * titled like one? A task never acts in them: they answer Ember's questions and hold its settings. Another program's
 * window that is only titled "Ember" (Files showing the ~/Ember hand-off folder) isn't one.
 */
export function isEmberWindow(w: { app?: string; name?: string; pid?: number | null }, ownPid: number = process.pid): boolean {
  if (w.pid != null && w.pid === ownPid) return true;
  if (EMBER_WINDOW.test(normalizeLabel(w.app ?? "").trim())) return true;
  return w.pid == null && EMBER_WINDOW.test(normalizeLabel(w.name ?? "").trim());
}
/** One list with the screen reader's (which also withholds these fields' contents), plus look-alike folding. */
export const isSecretField = (s: string) => SECRET_FIELD.test(normalizeLabel(s)) || isSecretLabel(normalizeLabel(s));

const ACTIVATING_ROLES = /button|link|menu item|check box|radio|toggle|switch|tab/;
/** Keys that activate the focused control (with Shift too, and the Ctrl+M / Ctrl+J line-feed equivalents), as keyFamily spells them. */
const ACTIVATE_KEY = /^((shift|ctrl|alt)\+)?(return|space)$|^ctrl\+(m|j)$/;
/** Is `keys` a key that activates whatever has focus (Enter, Space and their keypad twins)? */
export const isActivatingKey = (keys: string, kc: KeyConventions = KEYS.linux) => { const k = canonicalKeys(keys, kc); return !!k && ACTIVATE_KEY.test(keyFamily(k)); };
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
/** The logo key's names (Super, Meta, Hyper, Mod4) are `kc`'s logo token: "super" on Linux and Windows, "cmd" on macOS (⌘). */
const modifierName = (m: string, kc: KeyConventions) => {
  const name = MODIFIER_NAMES[m.toLowerCase().replace(/_[lr]$/, "")] ?? m.toLowerCase();
  return name === "super" ? kc.logoToken : name;
};

/**
 * One spelling for a key combination, the way Ember's keyboard will press it (parseCombo): modifiers in `kc`'s fixed
 * order (ctrl, alt, shift, super on Linux and Windows; ctrl, alt, shift, cmd on macOS) and the key's own name in lower
 * case, so "Alt + Ctrl + Del" is "ctrl+alt+delete" and "Super_L" is "super_l". The logo key's other names ("win",
 * "logo"; on Linux and Windows also "cmd") are its logo token. null when Ember's keyboard wouldn't understand it.
 */
export function canonicalKeys(keys: string, kc: KeyConventions = KEYS.linux): string | null {
  try {
    const { modifiers, key } = parseCombo(keys.split("+").map(t => (kc.logoAliases.test(t) ? kc.logoToken : t)).join("+"), kc);
    if (/\s/.test(key)) return null;
    // Keys by number ("0x74", "U0074", "U+0074"): X takes them too, so any key hides behind them. Never pressed.
    if (/^(0x[0-9a-f]+|u\+?[0-9a-f]{2,8})$/i.test(key)) return null;
    const order = kc.modifierOrder;
    const mods = [...new Set(modifiers.map(m => modifierName(m, kc)))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return [...mods, key.toLowerCase()].join("+");
  } catch {
    return null;
  }
}

/** @deprecated canonicalKeys (kept for callers that want a string either way). */
export function normalizeKeys(keys: string, kc: KeyConventions = KEYS.linux): string {
  return canonicalKeys(keys, kc) ?? keys.toLowerCase().replace(/\s+/g, "");
}

/** The modifiers of a canonical combination (`k` from canonicalKeys), its key counting as one when it is a modifier key. */
function modifiersOf(k: string, kc: KeyConventions): Set<string> {
  const parts = k.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts);
  if (/^(control|shift|alt|super|meta|hyper)_[lr]$/.test(key)) mods.add(modifierName(key, kc));
  return mods;
}
/** The modifiers of each of Ember's own shortcuts on an OS (SHORTCUTS[os] chords). */
const chordModifiers = perOS(os => Object.values(SHORTCUTS[os]).map(d => d.chord.split("+").slice(0, -1)));
/**
 * Is `k` in the family of one of Ember's own shortcuts: do its modifiers include all of that shortcut's (Windows: any
 * Win+Alt combination; macOS: any Control+Shift+Command one, with Option too)? On macOS the backend presses the key
 * that types a letter on the layout in use while the shortcuts are bound to fixed keys, so on another layout a task's
 * letter can land on Ember's Allow: refusing the whole family fails closed whichever way the layouts line up.
 */
function shortcutFamily(k: string, kc: KeyConventions): boolean {
  const mods = modifiersOf(k, kc);
  return chordModifiers(kc.os).some(chord => chord.every(m => mods.has(m)));
}

/**
 * The keys the Ctrl+Alt rules below can judge by name (as keyFamily spells them): an ASCII letter or digit, and the named
 * keys whose keysym sits on its own physical key in every layout: moving and editing keys, function keys, ASCII
 * punctuation (X's names for it) and the modifier and lock keys. Anything else ("cyrillic_ie", "gbreve", "é") Ember's
 * keyboard may press on whichever physical key another layout group puts it (ğ is on E on a us,tr(f) keyboard).
 */
const NAMED_BY_LATIN = new RegExp(`^([a-z0-9]|f\\d{1,2}|${[
  "up", "down", "left", "right", "home", "end", "prior", "next", "insert", "delete", "backspace", "tab", "return", "escape",
  "space", "menu", "pause", "break", "begin", "clear", "cancel", "help", "undo", "redo", "find",
  "minus", "plus", "equal", "comma", "period", "slash", "backslash", "semicolon", "apostrophe", "grave", "bracketleft",
  "bracketright", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand", "parenleft", "parenright",
  "asterisk", "colon", "less", "greater", "question", "at", "asciicircum", "underscore", "braceleft", "bar", "braceright",
  "asciitilde", "(control|shift|alt)_[lr]", "caps_lock", "num_lock", "scroll_lock", "shift_lock",
].join("|")})$`);

/**
 * Keys only the user presses (`k` from canonicalKeys): the logo key with anything, power, media and
 * screenshot keys, virtual consoles, the run dialog, terminals, locking and logging out, switching
 * workspaces, and Ember's own shortcuts (Ctrl+Alt+Y/N/A/X/Space/E/M/End), so a task can never answer
 * its own question or stop, hide or reconfigure Ember. Shift doesn't change that. Off Linux also every combination in
 * the family of Ember's own shortcuts there (shortcutFamily) and the OS's own (kc.systemKeys: the app switcher, the
 * task manager, Spotlight, screenshots). On macOS ⌘ is the primary modifier, so the logo-key rule isn't applied there.
 * On Linux also Ctrl+Alt with a key those rules can't judge by its name (NAMED_BY_LATIN).
 */
export function isSystemKey(k: string, kc: KeyConventions = KEYS.linux): boolean {
  const parts = keyFamily(k).split("+");
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  if (kc.logoToken === "super" && (mods.has("super") || /^(super|meta|hyper)(_[lr])?$/.test(key))) return true;
  if (/^xf86/.test(key) || /^(print|sys_req|sysrq)$/.test(key)) return true;
  const ctrlAlt = mods.has("ctrl") && mods.has("alt");
  if (ctrlAlt && /^f\d{1,2}$/.test(key)) return true;
  if (mods.has("alt") && !mods.has("ctrl") && /^f[12]$/.test(key)) return true;
  if (ctrlAlt && /^(backspace|delete|tab|t|l|up|down|left|right|y|n|a|x|space|e|m|end)$/.test(key)) return true;
  // Linux: the Ctrl+Alt rules above already cover Ember's own shortcuts, and nothing is added there but Ctrl+Alt with a
  // key they can't judge by name, which Ember's keyboard may press on another layout group's physical key
  // (Ctrl+Alt+Cyrillic_ie is Ctrl+Alt+T on a us,ru keyboard, Ctrl+Alt+gbreve Ctrl+Alt+E on a us,tr(f) one). Ctrl or Alt
  // alone reach no system key but F1 and F2 (above), so those are judged as any other key.
  if (kc.os === "linux") return ctrlAlt && !NAMED_BY_LATIN.test(key);
  return shortcutFamily(k, kc) || kc.systemKeys.includes(keyFamily(k));
}

/*
 * The key tables, written with "mod" for the primary modifier (Ctrl on Linux and Windows, Cmd on macOS), each entry
 * canonicalised for the OS. The Linux lists are the ones Ember had before the port with "ctrl" spelled "mod" (a test
 * compares the Linux tables with a frozen copy of them).
 */
/** Shortcuts that only move, select, copy, paste, undo, format, search or zoom: fine on Ember's desk. */
const SAFE_TEMPLATES = ["mod+a", "mod+c", "mod+x", "mod+v", "mod+z", "mod+y", "mod+shift+z", "mod+b", "mod+i", "mod+u",
  "mod+f", "mod+g", "mod+h", "mod+s", "mod+shift+s", "mod+n", "mod+t", "mod+l", "mod+o", "mod+home", "mod+end", "mod+left", "mod+right",
  "mod+up", "mod+down", "mod+shift+left", "mod+shift+right", "mod+shift+home", "mod+shift+end", "mod+backspace", "mod+plus", "mod+minus",
  "mod+equal", "mod+0", "mod+tab", "mod+shift+tab", "mod+prior", "mod+next", "mod+pageup", "mod+pagedown"];
/** macOS also moves by word with Option and to a document's start or end with ⌘↑ and ⌘↓ (Shift selects as it goes). */
const SAFE_EXTRA: Partial<Record<OS, readonly string[]>> = {
  darwin: ["alt+left", "alt+right", "alt+shift+left", "alt+shift+right", "cmd+up", "cmd+down", "cmd+shift+up", "cmd+shift+down"],
};
/** Shortcuts that delete, send, close or quit, whatever has focus. */
const DESTRUCTIVE_TEMPLATES = ["delete", "shift+delete", "mod+delete", "mod+shift+delete", "mod+return", "alt+return", "mod+shift+return",
  "alt+f4", "mod+q", "mod+w", "mod+shift+w", "mod+shift+q"];
/** macOS: ⌘⌫ deletes (in Finder it moves to the Trash), ⌥⇧⌘⌫ empties the Trash, ⌥⌘W and ⌥⌘Q close or quit everything. */
const DESTRUCTIVE_EXTRA: Partial<Record<OS, readonly string[]>> = {
  darwin: ["cmd+backspace", "shift+cmd+backspace", "alt+shift+cmd+backspace", "alt+cmd+w", "alt+cmd+q", "cmd+q", "cmd+w"],
};
/** Keys that paste whatever the clipboard holds. */
const PASTE_TEMPLATES = ["mod+v", "mod+shift+v", "shift+insert"];
/** macOS: Paste and Match Style. */
const PASTE_EXTRA: Partial<Record<OS, readonly string[]>> = { darwin: ["alt+shift+cmd+v"] };

/** An OS's key tables, and the expressions that name its primary modifier (canonical spellings, as keyFamily gives them). */
export interface KeyTables {
  /** Shortcuts that only move, select, copy, paste, undo, format, search or zoom. */
  readonly safe: ReadonlySet<string>;
  /** Shortcuts that delete, send, close or quit, whatever has focus. */
  readonly destructive: ReadonlySet<string>;
  /** Keys that paste whatever the clipboard holds. */
  readonly paste: ReadonlySet<string>;
  /** Keys that take away what is selected: Delete and Backspace (with Shift or the primary too), Cut (pastes are `paste`). */
  readonly removes: RegExp;
  /** Keys besides typing that replace a selection: Cut, Shift+Delete, the primary with Backspace or Delete. */
  readonly replaces: RegExp;
  /** Cut ("ctrl+x"; macOS "cmd+x"). */
  readonly cut: string;
}
const keyTablesMade = new WeakMap<KeyConventions, KeyTables>();
/** The key tables for `kc`, made once per conventions object. */
export function keyTables(kc: KeyConventions = KEYS.linux): KeyTables {
  const known = keyTablesMade.get(kc);
  if (known) return known;
  const canon = (entry: string) => { const e = entry.replace(/\bmod\b/g, kc.primary); return canonicalKeys(e, kc) ?? e; };
  const set = (list: readonly string[], extra: Partial<Record<OS, readonly string[]>>) => new Set([...list, ...(extra[kc.os] ?? [])].map(canon));
  // The primary modifier, and it with Shift in the OS's order ("ctrl+shift" on Linux, "shift+cmd" on macOS), as patterns.
  const p = kc.primary, ps = canon("mod+shift+x").replace(/\+x$/, "").replace(/\+/g, "\\+");
  const t: KeyTables = {
    safe: set(SAFE_TEMPLATES, SAFE_EXTRA),
    destructive: set(DESTRUCTIVE_TEMPLATES, DESTRUCTIVE_EXTRA),
    paste: set(PASTE_TEMPLATES, PASTE_EXTRA),
    removes: new RegExp(`^((shift|${p}|${ps})\\+)?(delete|backspace)$|^${p}\\+x$`),
    replaces: new RegExp(`^(${p}\\+x|shift\\+delete|(${p}|${ps})\\+(backspace|delete))$`),
    cut: canon("mod+x"),
  };
  keyTablesMade.set(kc, t);
  return t;
}
/** A shortcut: a combination with Ctrl, Alt, the logo key or ⌘ (no Linux combination has "cmd"). */
const SHORTCUT = /(^|\+)(ctrl|alt|super|cmd)\+/;
/** The letter or digit a key types (lower case), " " for the space bar, or null for any other key or shortcut. */
export function typedChar(keys: string, kc: KeyConventions = KEYS.linux): string | null {
  const k = keyFamily(canonicalKeys(keys, kc) ?? "");
  const m = /^(shift\+)?([a-z0-9])$/.exec(k);
  return m ? m[2] : /^(shift\+)?space$/.test(k) ? " " : null;
}
/** Keys (without Ctrl or Alt) that type nothing: they move the caret, switch modes or are modifiers themselves. */
const TYPES_NOTHING = /^(shift\+)?(escape|up|down|left|right|home|end|prior|next|insert|menu|pause|print|break|f\d{1,2}|caps_lock|num_lock|scroll_lock|(shift|control|alt|super|meta|hyper)_[lr]|iso_level3_shift|mode_switch|sys_req|xf86\w+)$/;
/** Keys that move the caret (a Ctrl+A selection ends there). */
export const MOVES_CARET = /(^|\+)(up|down|left|right|home|end|prior|next)$/;
/**
 * Does this key type a character (a letter, digit, symbol or Space, with or without Shift)? Shortcuts with Ctrl, Alt,
 * Super or ⌘, and keys that edit, move or switch (Enter, Tab, Backspace, Delete, arrows, F-keys) don't; neither does
 * anything Ember's keyboard wouldn't understand as a key (it may be text).
 */
export function typesCharacter(keys: string, kc: KeyConventions = KEYS.linux): boolean {
  const k = canonicalKeys(keys, kc);
  if (k === null) return true;
  const f = keyFamily(k);
  return !SHORTCUT.test(f) && !TYPES_NOTHING.test(f) && !/^(shift\+)?(return|tab|backspace|delete)$/.test(f);
}
/**
 * Does this key replace (or delete) what is selected? Any key that types (letters, digits, symbols, Space, Enter, Tab),
 * Backspace, Delete, Cut, the paste keys, and the primary modifier with Backspace or Delete (Ctrl+Backspace and
 * Ctrl+Delete delete the selection in GTK; so does ⌘⌫ on macOS).
 */
export function replacesSelection(keys: string, kc: KeyConventions = KEYS.linux): boolean {
  const k = keyFamily(canonicalKeys(keys, kc) ?? "");
  if (!k) return false;
  const t = keyTables(kc);
  if (t.paste.has(k) || t.replaces.test(k)) return true;
  return !SHORTCUT.test(k) && !TYPES_NOTHING.test(k);
}

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
/**
 * By its words: running with a program or a terminal ("Datei als Programm ausführen", "Lancer dans un terminal", "Esegui nel
 * terminale", "Разрешить выполнение файла как программы", "Kör i terminal"), in the languages of RISKY_WORDS (Nautilus
 * 3.28's own words where it has them), written with their accents (folded when matched). RUN_ANYWHERE and
 * PROGRAM_ANYWHERE are the scripts without spaces between words, matched anywhere in the label.
 */
const RUN_WORDS = ["run", "execute", "executing", "execution", "launch", "ausführen", "ausführung", "exécuter", "exécution", "lancer", "ejecutar",
  "ejecución", "eseguire", "esegui", "esecuzione", "executar", "execução",
  "uitvoeren", "uit te voeren", "uitvoering", "uruchom", "uruchomić", "uruchamianie", "uruchomienie", "wykonywanie", "wykonywania", "wykonać",
  "запустить", "запуск", "запуска", "выполнение", "выполнения", "выполнить", "выполнять", "исполнение", "kör", "köra", "körning", "kør", "køre",
  "kørsel", "kjør", "kjøre", "kjøring", "suorita", "suorittaa", "suorittaminen", "suoritus", "spustit", "spouštění", "spuštění", "spouštět",
  "çalıştır", "çalıştırma", "çalıştırılması", "çalıştırılmasına"];
const RUN_ANYWHERE = ["実行", "执行", "執行", "运行", "運行", "실행"];
const RUN_WORD = anyOf(RUN_WORDS);
const RUN_SOMEWHERE = new RegExp(foldLabel(RUN_ANYWHERE.join("|")), "u");
const PROGRAM_WORD = anyOf(["programs?", "programm", "programmes?", "programas?", "programma", "terminal", "terminale", "programu", "programem",
  "terminalu", "terminalvenster", "программа", "программы", "программу", "программой", "терминал", "терминале", "programmet", "terminalen",
  "ohjelma", "ohjelmana", "ohjelmaa", "pääte", "päätteessä", "terminálu", "terminál", "uçbirim", "uçbirimde"]);
const PROGRAM_SOMEWHERE = new RegExp(foldLabel(["プログラム", "端末", "程序", "程式", "终端", "終端", "프로그램", "터미널"].join("|")), "u");
/** A check box that is only "Execute" ("Ausführen:", "Exécution :"), or says the file is executable ("Is executable", "Ausführbar"). */
const RUN_ONLY = new RegExp(`^\\s*(${foldLabel([...RUN_WORDS, ...RUN_ANYWHERE].join("|"))})\\s*[:：]?\\s*$`, "u");
const EXECUTABLE_WORD = anyOf(["executables?", "ausführbar(e[nrs]?)?", "exécutables?", "ejecutables?", "eseguibil[ei]", "executáve(l|is)",
  "uitvoerbaar", "uitvoerbare", "wykonywaln(y|ym|ego|a|e|ą|ych)", "исполняем(ый|ым|ого|ая|ое|ые|ых)", "körbar[at]?", "kørbare?", "kjørbare?",
  "suoritettava[na]?", "spustiteln(ý|ým|ého|á|é)", "çalıştırılabilir"]);
const EXECUTABLE_SOMEWHERE = new RegExp(foldLabel(["実行可能", "可执行", "可執行", "실행 가능"].join("|")), "u");
const TOGGLE_ROLES = /check box|toggle|switch/;
/**
 * The file manager's "Do you want to run …, or display its contents?" question (and its autorun one), as Nautilus
 * versions word it, in the languages of RISKY_WORDS: its "Run" runs the file.
 */
const RUN_FILE_DIALOG = anyOf(["do you want to run", "display its contents", "would you like to run it", "inhalt anzeigen",
  "automatisch ausgeführt werden soll", "afficher son contenu", "souhaitez-vous le lancer", "(ver|mostrar) su contenido", "quiere ejecutarlo",
  "il suo contenuto", "visualizzarne il contenuto", "eseguirlo", "(exibir|mostrar) (o )?seu conteúdo", "gostaria de executá-lo",
  "inhoud ervan tonen", "wyświetlić jego zawartość", "показать его содержимое", "visa dess innehåll", "vise dens indhold", "vise innholdet",
  "näyttää sen sisällön", "zobrazit jeho obsah", "içeriğini görüntülemek"]);
const RUN_FILE_DIALOG_SOMEWHERE = new RegExp(foldLabel(["内容を表示", "显示它的内容", "顯示它的內容", "내용을 표시"].join("|")), "u");
/** That dialog's "Run" ("Ausführen", "Lancer", "Ejecutar", "Esegui", "Executar", "Запустить", "Kör", "実行する"), starting the label. */
const RUN_ANSWER = new RegExp(`^(${foldLabel(["run", "execute", "launch", "ausführen", "lancer", "ejecutar", "esegui", "executar", "uitvoeren", "uruchom",
  "запустить", "kör", "kør", "kjør", "suorita", "spustit", "çalıştır"].join("|"))})(?=$|[^\\p{L}\\p{N}])|^(${foldLabel(RUN_ANYWHERE.join("|"))})`, "u");
/** RUNS_PROGRAM_EXTRA[os] and RUN_FILE_DIALOG_EXTRA[os] (./vocabulary.ts) as expressions, or null where the OS adds none. */
const runsProgramExtra = perOS(os => (RUNS_PROGRAM_EXTRA[os].length ? anyOf([...RUNS_PROGRAM_EXTRA[os]]) : null));
const runFileDialogExtra = perOS(os => (RUN_FILE_DIALOG_EXTRA[os].length ? anyOf([...RUN_FILE_DIALOG_EXTRA[os]]) : null));
/** RUN_ANSWER_EXTRA[os] (./vocabulary.ts) as a whole word starting the label, as RUN_ANSWER is, or null where the OS adds none. */
const runAnswerExtra = perOS(os => (RUN_ANSWER_EXTRA[os].length ? new RegExp(`^(${foldLabel(RUN_ANSWER_EXTRA[os].join("|"))})(?=$|[^\\p{L}\\p{N}])`, "u") : null));
/** A text in both forms the checks below read: with look-alikes mapped (plainText), and as written (Cyrillic stays Cyrillic). */
const bothForms = (s: string) => { const a = plainText(s), b = foldLabel(s); return a === b ? [a] : [a, b]; };
/** Does activating this control make a file executable or run one (by `os`'s words too)? */
function runsProgram(role: string, name: string, dialog: { name: string; text: string } | undefined, os: OS): boolean {
  const labels = bothForms(name);
  const has = (re: RegExp | null) => !!re && labels.some(l => re.test(l));
  if (has(RUNS_PROGRAM) || has(TRUST_AND_LAUNCH) || has(runsProgramExtra(os))) return true;
  if (ACTIVATING_ROLES.test(role) && labels.some(l => (RUN_WORD.test(l) || RUN_SOMEWHERE.test(l)) && (PROGRAM_WORD.test(l) || PROGRAM_SOMEWHERE.test(l)))) return true;
  // The file's execute bit, by a check box on its Permissions page.
  if (TOGGLE_ROLES.test(role) && (has(RUN_ONLY) || has(EXECUTABLE_WORD) || has(EXECUTABLE_SOMEWHERE))) return true;
  const asks = bothForms(`${dialog?.name ?? ""} ${dialog?.text ?? ""}`);
  const said = (re: RegExp | null) => !!re && asks.some(a => re.test(a));
  const osRunDialog = said(runFileDialogExtra(os));
  // The OS's own answers (Gatekeeper's "Open") run the file only in its own dialogs.
  const runDialog = said(RUN_FILE_DIALOG) || said(RUN_FILE_DIALOG_SOMEWHERE) || said(EXECUTABLE_WORD) || said(EXECUTABLE_SOMEWHERE) || osRunDialog;
  return (has(RUN_ANSWER) && runDialog) || (osRunDialog && has(runAnswerExtra(os)));
}
/** "Paste" menu items and buttons, in the languages of RISKY_WORDS (GTK's and the browsers' own words). */
const PASTE_WORDS = ["paste", "einfügen", "coller", "pegar", "incolla", "colar", "plakken", "wklej", "вставить", "вставь", "klistra in", "indsæt",
  "lim inn", "liitä", "vložit", "yapıştır"];
const PASTE_ANYWHERE = ["貼り付け", "ペースト", "粘贴", "粘貼", "貼上", "붙여넣기", "붙여 넣기"];
const PASTE_LABEL = new RegExp(`^\\s*(${foldLabel(PASTE_WORDS.join("|"))})(?=$|[^\\p{L}])|${foldLabel(PASTE_ANYWHERE.join("|"))}`, "u");
/** By its words as written (Cyrillic stays Cyrillic), and with look-alikes mapped ("Pаste" with a Cyrillic а). */
const isPasteLabel = (s: string) => PASTE_LABEL.test(foldLabel(s)) || PASTE_LABEL.test(plainText(s));
/** Apps named in a question: "Thunderbird", "Thunderbird and Files", "A, B and C". */
const appList = (apps: string[]) => (apps.length > 1 ? `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1]}` : apps[0] ?? "");

/** Dialogs (Save As, Properties) go with their program's windows: not another place for text to go. */
const DIALOG_WINDOW = /^(dialog|alert|file chooser|color chooser|font chooser)$/;
/** Apps whose window shows one page, message or chat after another, its title saying which: there another title is another place (TABBED_APP). */
const tabbed = (app: string, os: OS) => TABBED_APP[os]?.test(app) ?? false;
/** A window's title with each path in it as its file's name ("/tmp/x/notes.txt - Mousepad" → "notes.txt - Mousepad"). */
const shortTitle = (t: string) => t.replace(/(^|[\s*•(])(?:~|\.{1,2})?(?:\/[^/\s]+)+\/([^/\s]+)/g, "$1$2");
/** Did the task read `s` somewhere other than where `r` acts: another app, another window, or (in a browser or mail client) another tab or message? */
function elsewhere(s: ReadSource, r: ActionRequest, os: OS): boolean {
  if (s.described || s.app.trim().toLowerCase() !== r.app.trim().toLowerCase()) return true;
  const w = r.windowId ?? {};
  if (s.pid != null && s.pid === w.pid && (DIALOG_WINDOW.test(s.role ?? "") || DIALOG_WINDOW.test(w.role ?? ""))) return false;
  const known = s.pid != null && w.pid != null && !!s.path && !!w.path;
  if (known && (s.pid !== w.pid || s.path !== w.path)) return true;
  if (s.window.trim() === r.window.trim()) return false;
  // The same window under another title (or one Ember can't tell apart but by its title).
  return !known || tabbed(r.app, os);
}
/** Letters and digits in a row that make a run of text recognisably from somewhere (shorter ones are everyday coincidences). */
const RUN = 12;
/** Decimal digits of other scripts ("١٢٣", "४५६") as ASCII digits (NFKC leaves them as they are): each is its place in its run of ten. */
const asciiDigits = (s: string) => s.replace(/\p{Nd}/gu, d => {
  const cp = d.codePointAt(0)!;
  if (cp < 0x80) return d;
  let zero = cp;
  while (zero > cp - 9 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
  return String(cp - zero);
});
/**
 * Text as the carry check reads it, on one line: compatibility forms, accents and case folded, invisible characters
 * gone, look-alike letters mapped ("аna" with a Cyrillic а is "ana"), other scripts' digits as ASCII, and every
 * line break a space.
 */
const flat = (s: string) => asciiDigits(foldLabel(normalizeLabel(s)));
/**
 * Text that was read, line by line (its lines are separate elements and labels: no run goes on from one into the
 * next), each line flat, the lines kept apart by "\n". Typed text is flat as a whole: a line break typed into a
 * one-line field is dropped there (Firefox's <input>), so what goes on across it is one run.
 */
const fold = (s: string) => s.split(/[\n\r]+/).map(flat).join("\n");
/** The letters and digits of folded text, the lines kept apart by "\n" ("Re: Layoff list" → "relayofflist"). */
const lettersOf = (folded: string) => folded.split("\n").map(l => l.replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean).join("\n");
/** Separators within a number (dashes of any kind, the minus sign, slash, dot, comma, apostrophe, plus, underscore, colon). */
const NUMBER_SEPARATORS = "-\\u2010-\\u2015\\u2212/.,'+_:";
/**
 * What may stand between the digits of one number: spaces and brackets, with one or two separators among them
 * ("84,000", "448 812", "84'000", "123-45-6789", "123--45--6789", "123_45_6789", "+1 (555) 123-4567", "12/03/1985").
 */
const NUMBER_GAP = new RegExp(`(\\d)(?:[ ()]{1,2}(?:[${NUMBER_SEPARATORS}]{1,2}[ ()]{0,2})?|[${NUMBER_SEPARATORS}]{1,2}[ ()]{0,2})(?=\\d)`, "g");
/** Numbers of five digits or more in folded text, however they are written ("84,000" → "84000", "123-45-6789" → "123456789"). */
const numbersOf = (folded: string) => folded.replace(NUMBER_GAP, "$1").match(/\d{5,}/g) ?? [];
/** A digit at most a NUMBER_GAP away from the end (or the start) of a text: a number there can go on past it. */
const DIGIT_BEFORE = new RegExp(`\\d[${NUMBER_SEPARATORS} ()]{0,5}$`);
const DIGIT_AFTER = new RegExp(`^[${NUMBER_SEPARATORS} ()]{0,5}\\d`);

/** What makes text recognisable: RUN letters and digits in a row, and numbers of five digits or more. */
interface Runs { grams: Set<string>; numbers: Set<string> }
/** A run within one line (text that was read keeps its lines apart: text on two lines is no run, it is two). */
const addGram = (out: Set<string>, g: string) => { if (!g.includes("\n")) out.add(g); };
const gramsOf = (c: string, out = new Set<string>()) => { for (let i = 0; i + RUN <= c.length; i++) addGram(out, c.slice(i, i + RUN)); return out; };
/** The runs of typed text (flat: line breaks in it join what is on either side). */
const runsOf = (s: string): Runs => { const f = flat(s); return { grams: gramsOf(lettersOf(f)), numbers: new Set(numbersOf(f)) }; };
/** The runs of `runs` that `text`, as read (line by line), holds too. */
function runsIn(runs: Runs, text: string): Set<string> {
  const found = new Set<string>();
  const folded = runs.grams.size || runs.numbers.size ? fold(text) : "";
  if (runs.grams.size) for (const g of gramsOf(lettersOf(folded))) if (runs.grams.has(g)) found.add(g);
  if (runs.numbers.size) {
    const numbers = numbersOf(folded);
    for (const n of runs.numbers) if (numbers.some(m => m.includes(n))) found.add(n);
  }
  return found;
}
// What a command carries from elsewhere in its task is judged as typing is (commands/carried.ts, critique integration-17).
export { runsIn, runsOf, type Runs };

/** Text around the place a number may continue through: enough for any number written out. */
const NUMBER_CONTEXT = 40;
/**
 * The runs the text in a field has once `value` goes into `before` (at its end, or `anywhere` when the caret is
 * unknown) and didn't have before: the value's own, and the ones it makes with the text on either side of it.
 * Both are typed-side text (flat): a field may drop line breaks.
 */
function addedRuns(before: string, value: string, anywhere: boolean): Runs {
  const fb = flat(before), fv = flat(value), cb = lettersOf(fb), cv = lettersOf(fv);
  const grams = gramsOf(cv);
  if (cv) {
    for (let q = anywhere ? 0 : cb.length; q <= cb.length; q++) {
      const left = cb.slice(Math.max(0, q - RUN + 1), q);
      const s = left + cv + cb.slice(q, q + RUN - 1);
      // The runs across either edge of the value (the ones inside it are above).
      for (let i = 0; i < left.length && i + RUN <= s.length; i++) addGram(grams, s.slice(i, i + RUN));
      for (let i = Math.max(left.length, left.length + cv.length - RUN + 1); i < left.length + cv.length && i + RUN <= s.length; i++) addGram(grams, s.slice(i, i + RUN));
    }
  }
  const own = numbersOf(fv);
  const numbers = new Set(own);
  if (/\d/.test(fv)) {
    // Only the value's edges join the digits beside it ("448" after "812"); a number inside it is the same anywhere.
    const v = fv.length > 2 * NUMBER_CONTEXT ? `${fv.slice(0, NUMBER_CONTEXT)}x${fv.slice(-NUMBER_CONTEXT)}` : fv;
    for (let p = anywhere ? 0 : fb.length; p <= fb.length; p++) {
      if (!DIGIT_BEFORE.test(fb.slice(Math.max(0, p - 6), p)) && !DIGIT_AFTER.test(fb.slice(p, p + 6))) continue;
      const around = numbersOf(fb.slice(Math.max(0, p - NUMBER_CONTEXT), p) + v + fb.slice(p, p + NUMBER_CONTEXT));
      for (const n of around) if (!own.some(m => m.includes(n))) numbers.add(n);
    }
  }
  // What the field held already isn't new there.
  const held = gramsOf(cb), heldNumbers = numbersOf(fb);
  return {
    grams: new Set([...grams].filter(g => !held.has(g))),
    numbers: new Set([...numbers].filter(n => !heldNumbers.some(m => m.includes(n)))),
  };
}

/** The runs `text` makes after what was typed before it (`all`: that, then `text`; nothing when `all` doesn't end with it). */
const afterTyped = (runs: Runs, all: string | undefined, text: string) => {
  const prior = all && all.endsWith(text) ? all.slice(0, all.length - text.length) : all ?? "";
  if (!prior) return;
  const more = addedRuns(prior, text, false);
  for (const g of more.grams) runs.grams.add(g);
  for (const n of more.numbers) runs.numbers.add(n);
};

/**
 * What text going into a field is judged by: all of it when it replaces everything (type_text's "replace", a key
 * after Ctrl+A); otherwise its runs that are new there, with what the field holds now on either side of it (after it
 * for "append"; anywhere for "insert" and keys, the caret being unknown), and after what this task typed there before
 * (`typed`), so text typed in pieces is judged as a whole. Whatever the mode, also after what the task typed into the
 * window's other fields before (`typedHere`): a number or an address split over several fields is one text too.
 * Null when nothing is typed.
 */
function enteringRuns(r: ActionRequest, kc: KeyConventions): Runs | null {
  const text = r.kind === "text" || r.kind === "cursor_text";
  const now = text ? r.value ?? "" : r.kind === "keys" ? typedChar(r.value ?? "", kc) ?? "" : "";
  if (!now) return null;
  let runs: Runs;
  if (text ? (r.mode ?? "replace") === "replace" : r.afterSelectAll) runs = runsOf(now);
  else {
    runs = r.currentText !== undefined ? addedRuns(r.currentText, now, !text || r.mode === "insert") : runsOf(now);
    afterTyped(runs, r.typed, now);
  }
  // A piece the user said themselves (of four letters or digits or more: for keys, all this task typed into the field)
  // joins nothing carried to what went into the other fields: their name, then their city, aren't an address read elsewhere.
  const piece = lettersOf(flat(text ? now : r.typed ?? now));
  if (piece.length < 4 || !lettersOf(fold(r.goal ?? "")).split("\n").some(l => l.includes(piece))) afterTyped(runs, r.typedHere, now);
  return runs;
}

/** Words that say nothing about what is asked for ("quite" isn't "quit"). */
const STOP = new Set(["the", "and", "for", "with", "this", "that", "all", "now", "you", "your", "button", "item", "quite"]);
const words = (s: string) => foldLabel(s).match(/[\p{L}\p{N}]{3,}/gu)?.filter(w => !STOP.has(w)) ?? [];
/** Scripts written without spaces between words. */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A Korean verb's stem without the "-기" that makes it a button's noun ("보내기" → "보내", as in "보내 줘"). */
const hangulStem = (t: string) => (/\p{Script=Hangul}{2,}기$/u.test(t) ? t.slice(0, -1) : t);
/** Rough stem, so "deleting", "deleted" and "delete" match (and "replies", "replied" and "reply"). */
const stem = (w: string) => w.replace(/i(es|ed)$/, "y").replace(/(ing|ed|es|s|e)$/, "");
/**
 * Endings that make another form of a word, not another word: English inflections, and the endings of the other
 * languages' verbs ("invia" and "inviare", "lösche" and "löschen", "удали" and "удалить", "supprime" and "supprimer").
 * Not "checkout" for "check", "authorize" for "author", "executive" for "execute", "clearly" for "clear".
 */
const INFLECTION = /^(s|es|d|ed|ing|er|ers|ion|ions|al|ment|ments|n|en|r|re|ez|t|te|ть|те|ите)$/;
/** The same word, roughly: one stem, or one stem of five letters or more and the other that stem with an inflection. */
const sameWord = (a: string, b: string) => {
  const x = stem(a), y = stem(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.startsWith(short) && INFLECTION.test(long.slice(short.length));
};
/** Phrases that say one risky thing in several words, as one word: in the request and on the control alike. */
const PHRASES: [RegExp, string][] = [
  // "throw away my changes" (before "throw away" is trashing).
  [/\b(throw away|lose|drop|scrap|forget|discard) (the |my |all |any |your |these |those )?(unsaved |recent )?(changes|edits)\b/g, " nosave "],
  // "sign up for the newsletter", "write back to Ana", "put the settings back to default".
  [/\bsign ?(me |us |you )?up\b/g, " subscribe "],
  [/\bwrite back\b/g, " reply "],
  [/\b(put|set|change|turn|bring|switch)((?: \S+){0,3}?) back to (the )?(factory )?defaults?\b/g, " reset$2 defaults "],
  [/\brestore (the )?(factory )?defaults?\b/g, " reset defaults "],
  // "move report.txt to the trash" (what is moved stays: it names what the request acts on).
  [/\b(move|send|put|throw|drag)((?: \S+){0,3}?) (to|in|into) (the )?(trash|bin|wastebasket|rubbish bin)\b/g, " trash$2 "],
  [/\b(throw (it |them |this |these |that |those )?away|get rid of)\b/g, " trash "],
  [/\b(log ?(me |us |you |him |her |them )?(out|off)|sign ?(me |us |you |him |her |them )?out)\b/g, " logout "],
  [/\b(shut ?down|power ?off)\b/g, " shutdown "],
  // "Don't Save", "Close without Saving", "close it without saving", "discard my changes".
  [/\b((close|quit|exit)( \S+){0,2} )?(without saving|don't save|do not save|discard (the |my |all |any |your )?(unsaved )?changes)\b/g, " nosave "],
];
/** Phrases that are one harmless thing: "Sign in" and "Log in" aren't signing anything ("Sign in to checkout" checks out). */
const PLAIN_PHRASES: [RegExp, string][] = [[/\b(sign|log) ?(in|on)\b/g, " signin "]];
const asOneWord = (s: string) => [...PHRASES, ...PLAIN_PHRASES].reduce((t, [re, w]) => t.replace(re, w), foldLabel(s));
/**
 * Phrases only a request says: "let Ana know" (not "let me know") tells her, as a DM does; "say yes" or "RSVP yes" to an
 * invitation accepts it.
 */
const REQUEST_PHRASES: [RegExp, string][] = [[/\blet (?!(?:me|us)\b)((?:\S+ ){1,3}?)know\b/g, " notify $1"], [/\bdm\b/g, " message "], [/\b(say|rsvp) (yes|ok|okay)\b/g, " accept "]];
/** The words PHRASES makes that are a risky verb, though no risky word alone. */
const PHRASE_VERBS = new Set(["nosave"]);
/** Words that ask for the same thing: "delete report.txt" asks for "Move to Trash", "remove row 5" for "Delete Rows", "sign me out" for "Log Out". */
const SAME_ASK = [["delete", "remove", "erase", "trash", "discard", "wipe", "purge", "clear", "empty"], ["uninstall", "remove", "delete"], ["replace", "overwrite"],
  ["send", "submit"], ["quit", "exit", "close"], ["restart", "reboot"], ["nosave", "discard"]];
/**
 * Requests that ask for a control's word too, one way only: replying, answering, mailing, telling, forwarding, letting
 * someone know, texting, pinging or inviting asks for "Send" ("Reply" for an answer); commenting for "Post"; ordering
 * or buying asks for "Buy now", "Place order",
 * "Checkout" and "Pay"; paying for "Submit payment" and "Confirm payment"; booking for "Confirm booking"; sharing for
 * the share dialog's "Send"; changing, fixing or correcting text for "Replace" (Find & Replace's "Replace All")
 * ("Forward" isn't asked for by "reply to Ana", nor "Buy" by "pay my bill", nor "Change" by "replace the logo").
 */
const ASKS_FOR: [string[], string[]][] = [
  [["reply", "answer", "respond", "email", "mail", "message", "tell", "forward", "share", "notify", "text", "ping", "invite"], ["send"]],
  [["answer", "respond"], ["reply"]],
  [["comment"], ["post", "submit"]],
  [["order", "buy", "purchase", "checkout"], ["order", "buy", "purchase", "checkout", "pay"]],
  [["pay"], ["submit", "confirm"]],
  [["book", "reserve"], ["book", "reserve", "confirm"]],
  [["change", "fix", "correct", "update", "edit", "swap", "substitute"], ["replace"]],
];
/** Does the asked word `a` ask for the control's word `b`? */
const sameAsk = (a: string, b: string) => sameWord(a, b) || SAME_ASK.some(g => g.some(x => sameWord(x, a)) && g.some(x => sameWord(x, b)))
  || ASKS_FOR.some(([asks, controls]) => asks.some(x => sameWord(x, a)) && controls.some(x => sameWord(x, b)));

/**
 * Request words that are as often a noun or an adjective as the verb: "summarize this email", "the status of my
 * order", "in order to", "fill in the empty cells", "read the comments". Where they aren't the verb they ask for nothing.
 */
const NOT_ALWAYS_VERB = /^(e?mails?|messages?|orders?|answers?|repl(y|ies)|posts?|reports?|comments?|invites?|invitations?|checkouts?|purchases?|transfers?|shares?|sharing|archives?|trash|empty|clear|changes?|updates?|edits?|fix(es)?|correct|corrections?|merges?|commits?|push(es)?|blocks?|tweets?|retweets?|deletions?|removals?|replacements?|installations?|installs?|submissions?|texts?|pings?|dms?|drafts?)$/;
/** What a noun comes after ("this email", "my new messages", "Ana's reply"; at most two words between: "the last two emails"). */
const DETERMINER = /^(the|a|an|this|that|these|those|my|your|his|her|its|our|their|any|some|every|each|another|which|what|whose|all)$|'s?$/;
const PREPOSITION = /^(of|for|from|in|on|about|into|at|by|via|with|within|without|under|over|regarding|like|than|per|between|among|inside|through)$/;
/** Words that end a phrase: what comes after them is said anew ("the file, then email it", "the report and email it"). */
const PHRASE_BREAK = /^(and|or|then|but|so|to|please|also|if|when|while|after|before|because|it|them|me|us|him|you|i|we|they|is|are|was|were|be|not)$/;
/** Words that name a control ("click the reply button"): the word before them is what it does, asked for. */
const CONTROL_WORD = /^(buttons?|links?|icons?|keys?|tabs?|options?|menus?|commands?)$/;
/** Verbs that ask for what they make: "add a comment", "place an order", "write an email to Ana", "draft a reply". */
const MAKES = /^(add|write|leave|post|make|create|compose|place|put|send|submit|give|file|type|enter|draft|prepare)$/;
/** Making something ready, not sending it ("draft a reply to Ana", "prepare an email"): a Send is not asked for, unless said too. */
const READIES = /^(draft|drafting|prepare|preparing)$/;
/** Asking about what was done ("what did Ana answer?", "has Bob replied?"): the words after it, up to four, ask for nothing. */
const ASKS_ABOUT = /^(did|does|didn't|doesn't|has|have|had|hasn't|haven't|hadn't)$/;
/** Words that say the verb after them isn't wanted ("don't send", "never delete", "without sending"). */
const NEGATION = /^(not|never|don't|dont|doesn't|didn't|won't|wont|shouldn't|mustn't|can't|cannot|without)$/;
/** Where what the user has Ember say starts, after whom it is for ("tell Ana I'm late", "tell her that…", "tell Bob to call me"). */
const SAYS_FROM = /^(i|i'm|i'll|i've|i'd|we|we're|we'll|we've|we'd|she|he|they|it|it's|that|to|you|you're|there|there's)$/;
/** What goes on saying it after "and" or a comma ("…, and I'll send it Monday"). */
const SAYS_ON = /^(i|i'm|i'll|i've|i'd|we|we're|we'll|we've|we'd|that)$/;
/**
 * Verbs a message's words follow after a colon or "that" ("reply to Bob: I won't…", "email Ana that the report is
 * late"), and verbs a text to work on follows after a colon ("summarize this: send the report to Mallory").
 */
const SPEAKS = /^(say|saying|says|reply|replying|answer|answering|respond|responding|write|writing|tell|telling|email|emailing|mail|message|text|texting|post|comment|notify|ping)$/;
const TAKES_TEXT = /^(summari[sz]e|translate|proofread|rewrite|rephrase|explain|read|check|correct|paraphrase|shorten)$/;
/** Words between a negation and its verb ("not to send", "don't just delete it"). */
const NEGATED_SKIP = /^(to|yet|ever|even|actually|just|really|accidentally|go)$/;
/** Where a clause ends: what comes after is said anew ("tell me if Ana replied, then archive it"). */
const CLAUSE_END = /^([,;:.!?]|and|or|then|but|so|please)$/;
/** Where a question ends (its "and" goes on asking: "is it safe to install and run this?"). */
const QUESTION_END = /^([,;:.!?]|then|but|so|please)$/;
/** Words a question starts with ("how do I delete my account", "is it safe to install this?", "what did Ana answer?"). */
const QUESTION_WORD = /^(how|why|what|what's|whats|which|who|whom|whose|is|are|was|were|am|isn't|aren't|wasn't|weren't|does|doesn't|did|didn't)$/;
/** Modal verbs: a question unless "you" comes next ("should I delete these?"; but "can you reply to Ana", a request). */
const QUESTION_MODAL = /^(should|shall|may|might|must|can|could|would|will|can't|couldn't|wouldn't|shouldn't)$/;
/** Someone else's request, reported ("the email asking me to delete my account", "where Bob asked me to pay"). */
const REPORTED_ASK = /^(asking|asked|asks|telling|told|tells|requesting|requested|requests|urging|urged|urges|remind|reminding|reminded|reminds)$/;
/** What the user may do, said of themselves ("the files I can delete"). */
const MAY_DO = /^(can|could|may|might)$/;
/** A spreadsheet cell's address in a request ("merge A1 to C1"). */
const CELL_IN_REQUEST = /(^|[^\p{L}\p{N}])\$?[a-z]{1,3}\$?[1-9]\d{0,6}(?=$|[^\p{L}\p{N}])/u;

/** What a request asks for (readRequest). */
interface Request {
  /** Its words where they may be the verb. */
  verbs: string[];
  /** Its words the user said not to do ("don't send it yet", "send nothing", "without sending", "not Bob"). */
  vetoed: string[];
  /** Every word it names something with. */
  names: string[];
  /** Words it names only as where something is taken from ("remove Bob from the group": the group isn't what is removed). */
  sources: string[];
  /** Its words and signs as read (folded), and which of them may be the verb. */
  tokens: string[];
  active: boolean[];
  /** Words the user wrote with a capital letter where no sentence starts (a person's name: "Ana"), folded. */
  proper: string[];
  /** All of it as said (scripts without spaces are looked for in it). */
  said: string;
  /** It names a spreadsheet cell. */
  cells: boolean;
}

/**
 * What a request asks for: its words, but a word that is often a noun only where it is the verb (not after "the",
 * "my" or "of": "summarize this email", "the status of my order"; but "click the reply button", "add a comment",
 * "place an order", "draft a reply"); none in a question about what was done ("what did Ana answer?") or how to do
 * something ("how do I delete my account", "is it safe to install this?"), in an "if" or "whether" clause ("tell me if
 * Ana replied"), in someone else's request ("the email asking me to delete my account", unless the user says to do it:
 * "…, please do it"), in what the user has Ember say ("reply to Ana and say I can't send it today", "tell Ana I'll pay
 * tomorrow"), in what the user can do ("the files I can delete") or will do themselves ("I'll send it myself"), after
 * "don't", "never", "without", "instead of" or "rather than", before "nothing" ("send nothing"), or "tell" in "tell me".
 * A request asked as a question is one ("can you…", "could we…", "is it possible to…", "how about deleting…", "delete
 * them, can you?"). The ones said not to be done are vetoed too ("reply to Ana but don't send it yet": "Send" isn't
 * asked for, though "reply" asks for it), and so is a Send where the request only readies something ("draft a reply").
 * Every word names something, whatever it is.
 */
function readRequest(goal: string): Request {
  const text = REQUEST_PHRASES.reduce((t, [re, w]) => t.replace(re, w), asOneWord(goal)).replace(/\bwi-?fi\b/g, "wifi").replace(/\be-mail/g, "email");
  const tokens = text.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*'?|[^\s\p{L}\p{N}]/gu) ?? [];
  const word = (i: number) => i >= 0 && i < tokens.length && /[\p{L}\p{N}]/u.test(tokens[i]);
  const anchor = (t: string) => DETERMINER.test(t) || PREPOSITION.test(t);
  const not = new Set<number>();
  const vetoed: string[] = [];
  /** What the user has Ember say. */
  const speech = new Set<number>();
  /** The words from `from` on, to the end of their clause, ask for nothing. */
  const quiet = (from: number, ends = CLAUSE_END) => { for (let j = from; j < tokens.length && !ends.test(tokens[j]); j++) if (word(j)) not.add(j); };
  /** Where the clause that `from` is in ends. */
  const clauseEnd = (from: number) => { let j = from; while (j < tokens.length && !CLAUSE_END.test(tokens[j])) j++; return j; };
  /** The verb (or what is named: "not Bob", "not the archive") at `j` or just after it is said not to be done. */
  const negate = (j: number) => {
    while (NEGATED_SKIP.test(tokens[j] ?? "") || (DETERMINER.test(tokens[j] ?? "") && word(j + 1))) j++;
    if (word(j)) { not.add(j); vetoed.push(tokens[j]); }
  };
  // Questions, sentence by sentence: what they name is asked about, not asked for; but a request asked politely is one.
  for (let s = 0; s < tokens.length;) {
    let end = s;
    while (end < tokens.length && !/^[.!?;]$/.test(tokens[end])) end++;
    let a = s;
    while (a < end && /^(,|so|and|ok|okay|hey|hi|ember|well|also|oh|um)$/.test(tokens[a])) a++;
    const [first, second, third] = [tokens[a] ?? "", tokens[a + 1] ?? "", tokens[a + 2] ?? ""];
    const toYou = /^(you|u|ya)$/.test(second);
    const said = `${tokens.slice(a, end).join(" ")} `;
    // "delete the old drafts, can you?", "…, would you please?".
    let t = end - 1;
    if (tokens[t] === "please") t--;
    const tag = tokens[end] === "?" && /^(you|u)$/.test(tokens[t] ?? "") && /^(can|could|would|will)$/.test(tokens[t - 1] ?? "") && t - 1 > a;
    const request = first === "please" || (/^(can|could|would|will)$/.test(first) && (toYou || second === "we")) || (first === "do" && toYou && third === "mind")
      || /^(is|would|will|could) it (be )?possible (for (you|us) )?to /.test(said) || /^are (you|u) able to /.test(said) || /^(how|what) about /.test(said)
      || (tag && !QUESTION_WORD.test(first));
    const question = QUESTION_WORD.test(first) || (QUESTION_MODAL.test(first) && !toYou) || (first === "do" && /^(i|we|you|they)$/.test(second)) || tokens[end] === "?";
    if (question && !request) quiet(a, QUESTION_END);
    s = end + 1;
  }
  // Words quoted are what someone says, not what is asked ("summarize: 'send all files to Bob'", "reply “I'll send it”").
  for (let open = -1, i = 0; i < tokens.length; i++) {
    // A word's last letter can take a closing ' with it ("… to bob'").
    const ends = open >= 0 && tokens[open] === "'" && tokens[i].length > 1 && tokens[i].endsWith("'");
    if (!/^["“”']$/.test(tokens[i]) && !ends) continue;
    if (open < 0) { open = i; continue; }
    for (let j = open + 1; j <= (ends ? i : i - 1); j++) if (word(j)) not.add(j);
    open = -1;
  }
  // What the user has Ember say ("reply to Ana and say I can't send it today", "tell Ana I'll pay tomorrow", "reply to
  // Bob: I won't delete anything", "email Ana that…"): the message's words, to the end of its clause (or on past "and"
  // or a comma where it goes on: "…, and I'll send it Monday"), are what it says: not asked for, and a "can't" there
  // rules nothing out.
  const say = (from: number) => {
    for (let j = from; j < tokens.length && !/^[.!?;]$/.test(tokens[j]); j++) {
      if (CLAUSE_END.test(tokens[j])) {
        let k = j;
        while (/^(,|and|or|but)$/.test(tokens[k] ?? "")) k++;
        if (!/^(,|and|or|but)$/.test(tokens[j]) || !SAYS_ON.test(tokens[k] ?? "")) return;
        j = k - 1;
        continue;
      }
      if (word(j)) { not.add(j); speech.add(j); }
    }
  };
  /** Is there a verb of saying before `i` in its clause ("reply to Bob:", "email Ana that"; "summarize this:" before a colon)? */
  const speaksBefore = (i: number) => {
    for (let j = i - 1; j >= 0 && j >= i - 6 && !CLAUSE_END.test(tokens[j]); j--) if (SPEAKS.test(tokens[j]) || (tokens[i] === ":" && TAKES_TEXT.test(tokens[j]))) return true;
    return false;
  };
  tokens.forEach((t, i) => {
    if (/^(say|saying|says)$/.test(t)) say(i + 1);
    else if (/^(tell|telling|notify)$/.test(t) && !/^(me|us)$/.test(tokens[i + 1] ?? "")) {
      for (let j = i + 2; j <= i + 5 && j < tokens.length && !CLAUSE_END.test(tokens[j]); j++) if (SAYS_FROM.test(tokens[j])) { say(j); break; }
    } else if ((t === ":" || t === "that") && speaksBefore(i)) say(i + 1);
  });
  /** Someone else's requests reported: where what they ask starts. */
  const reported: number[] = [];
  tokens.forEach((t, i) => {
    if (ASKS_ABOUT.test(t) && tokens[i + 1] !== "to") {
      for (let j = i + 1; j <= i + 4 && word(j) && !/^(and|or|then|but|so|to|please|if|when|because)$/.test(tokens[j]); j++) not.add(j);
    }
    const said = speech.has(i);
    if (NEGATION.test(t) && !said) negate(i + 1);
    if (t === "no" && tokens[i + 1] === "need" && tokens[i + 2] === "to" && !said) negate(i + 3);
    if (t === "nothing" && !said) {
      if (word(i - 1)) { not.add(i - 1); vetoed.push(tokens[i - 1]); }
      if (tokens[i + 1] === "to") negate(i + 2);
    }
    // "move it to the archive instead of deleting it", "archive them rather than delete them".
    if (((t === "instead" && tokens[i + 1] === "of") || (t === "rather" && tokens[i + 1] === "than")) && !said) negate(i + 2);
    // "I'll send it myself", "we'll post it ourselves": the user does that, not Ember.
    if (/^(myself|ourselves)$/.test(t) && !said) {
      let j = i - 1;
      while (j >= 0 && !CLAUSE_END.test(tokens[j])) j--;
      const k = tokens.slice(j + 1, i).findIndex(x => /^(i'll|we'll|i|we)$/.test(x));
      if (k >= 0) {
        for (let m = j + k + 2; m < i; m++) if (word(m) && !/^(will|shall|can|could|do|it|them|this|that|the|a|an)$/.test(tokens[m])) { not.add(m); vetoed.push(tokens[m]); }
      }
    }
    if (/^(if|whether)$/.test(t)) quiet(i + 1);
    // "show me how to delete my account", "tell me what to send", "show me which apps to uninstall" (but "how about
    // deleting them" asks for it).
    if (/^(how|what|which)$/.test(t) && tokens[i + 1] !== "about") quiet(i + 1, QUESTION_END);
    // "find emails to delete", "list the drafts to remove": what to do to them is what is looked for.
    if (/^(find|list|show|search|look|identify|suggest|recommend)$/.test(t)) {
      for (let j = i + 1; j < tokens.length && !CLAUSE_END.test(tokens[j]); j++) if (tokens[j] === "to" && word(j + 1)) { quiet(j + 1); break; }
    }
    if (REPORTED_ASK.test(t)) {
      const j = /^(me|us)$/.test(tokens[i + 1] ?? "") ? i + 2 : i + 1;
      if (tokens[j] === "to") reported.push(j + 1);
    }
    if (/^(i|we)$/.test(t) && MAY_DO.test(tokens[i + 1] ?? "")) quiet(i + 2);
    // What something is about ("the thread about deleting old files"): a doing named, not asked for ("how about deleting
    // them" asks for it).
    if (/ing$/.test(t) && /^(about|regarding|concerning)$/.test(tokens[i - 1] ?? "") && !/^(how|what)$/.test(tokens[i - 2] ?? "")) not.add(i);
    if (t === "tell" && /^(me|us)$/.test(tokens[i + 1] ?? "")) not.add(i);
    if (!NOT_ALWAYS_VERB.test(t) || CONTROL_WORD.test(tokens[i + 1] ?? "")) return;
    let j = i - 1;
    while (j > i - 3 && word(j) && !anchor(tokens[j]) && !PHRASE_BREAK.test(tokens[j])) j--;
    if (!word(j) || !anchor(tokens[j])) return;
    // "by email" says how to send it; "add a comment" asks for one.
    const noun = DETERMINER.test(tokens[j]) ? !MAKES.test(tokens[j - 1] ?? "") : !(/^(by|via)$/.test(tokens[j]) && /^(e?mail|message)/.test(t));
    if (noun) not.add(i);
  });
  // Someone else's request is asked for only where the user says to do it after it ("Ana asked me to delete the
  // drafts, please do it", "…, go ahead").
  for (const from of reported) {
    const end = clauseEnd(from);
    const done = tokens.some((t, d) => d > end && !not.has(d) && !speech.has(d)
      && ((t === "do" && (/^(it|that|so|this)$/.test(tokens[d + 1] ?? "") || /^[.!]?$/.test(tokens[d + 1] ?? ""))) || (t === "go" && tokens[d + 1] === "ahead")));
    if (!done) quiet(from);
  }
  // Readying something isn't sending it ("draft a reply to Ana", "prepare the email"), where nothing else asks for a
  // Send ("prepare the invoice and email it to Ana" does).
  const readies = tokens.flatMap((t, i) => (READIES.test(t) && !not.has(i) ? [i, i + 1, i + 2, i + 3] : []));
  if (readies.length && !tokens.some((t, i) => word(i) && !not.has(i) && !readies.includes(i) && sameAsk(t, "send"))) vetoed.push("send");
  const active = tokens.map((_t, i) => word(i) && !not.has(i));
  const verbs = tokens.filter((_t, i) => active[i]).flatMap(t => words(t));
  // What something is taken from ("remove Bob from the group", "delete the photo out of the album").
  const from = new Set<number>();
  tokens.forEach((t, i) => {
    const start = t === "from" ? i + 1 : t === "out" && tokens[i + 1] === "of" ? i + 2 : -1;
    for (let j = start; j >= 0 && j < tokens.length && !CLAUSE_END.test(tokens[j]) && !/^(to|into|onto|in)$/.test(tokens[j]); j++) from.add(j);
  });
  const elsewhere = new Set(tokens.filter((_t, i) => !from.has(i)).flatMap(t => words(t)));
  const sources = [...new Set(tokens.filter((_t, i) => from.has(i)).flatMap(t => words(t)))].filter(w => !elsewhere.has(w));
  // Capitalised words, but where a sentence starts.
  const proper: string[] = [];
  let starts = true;
  for (const [t] of goal.normalize("NFKC").matchAll(/[\p{L}\p{N}]+|[.!?]/gu)) {
    if (/^[.!?]$/.test(t)) { starts = true; continue; }
    if (!starts && /^\p{Lu}/u.test(t)) proper.push(foldLabel(t));
    starts = false;
  }
  return { verbs, vetoed, names: words(text), sources, tokens, active, proper, said: `${normalizeLabel(goal)} ${foldLabel(goal)} ${text}`, cells: CELL_IN_REQUEST.test(text) };
}

/** Words on a control that don't say what it acts on: pointing words, "permanently", "selected", files in general. */
const ANY_THING = new Set(["it", "them", "these", "those", "everything", "anything", "both", "each", "every", "any", "some", "here", "there", "again",
  "anyway", "permanently", "forever", "immediately", "today", "yes", "okay", "link", "from", "into", "onto", "out", "off", "via", "per", "his", "her",
  "its", "our", "their", "mine", "yours", "only", "just", "also", "more", "still", "too", "then", "later", "selected", "selection", "items", "file",
  "files", "entry", "entries", "content", "contents", "current", "checked", "marked", "highlighted", "unsaved", "changes", "find", "signin"]);
/** Words that only agree to what a control does ("Confirm transfer", "Proceed to checkout", "Complete purchase"): not what it acts on. */
const CONFIRMS = /^(confirm|proceed|complete|continue|finish|finali[sz]e)$/;
/** Controls that send or post, and what they send in general (a message, an email, a reply: "Send message"). */
const SENDS = ["send", "reply", "forward", "post", "submit", "share", "publish", "comment", "respond", "answer", "tweet"];
const MESSAGE_THING = /^(e?mails?|messages?|repl(y|ies)|responses?|answers?|comments?|posts?|notes?|texts?|chats?|tweets?)$/;
/** Controls that order or pay, and what they act on in general ("Place order", "Complete purchase", "Confirm and pay", the cart, its total). */
const BUYS = ["order", "buy", "purchase", "checkout", "pay"];
const ORDER_THING = /^(place|complete|proceed|secure|securely|confirm|continue|submit|review|finish|finali[sz]e|orders?|purchases?|payments?|carts?|baskets?|bags?|total|checkout|usd|eur|gbp|chf|jpy|cad|aud)$/;
/** Money on a control ("Send $500"): there an amount is what it sends. */
const MONEY = /[$€£¥₹]|\b(usd|eur|gbp|chf|jpy|cad|aud|inr)\b/i;
/** Things named in other words: "forget the CoffeeShop wifi" names "Forget Connection"'s connection, "clear my browsing history" "Clear data"'s data. */
const SAME_THING = [["connection", "network", "wifi", "wlan", "hotspot", "ssid", "vpn"], ["data", "history", "cookies", "cache", "browsing"],
  ["message", "email", "mail", "conversation", "thread", "draft"], ["row", "line"], ["folder", "directory"], ["picture", "photo", "image"],
  ["app", "application", "program", "package", "software"], ["form", "application", "request", "registration", "submission", "feedback", "survey", "questionnaire"]];
/** The ending that makes a verb its noun ("invite" → "invitation", "pay" → "payment", "approve" → "approval"). */
const NOUN_ENDING = /^(ation|ations|ment|ments|al|als)$/;
/** Is `noun` the noun of `verb`? */
const nounOf = (verb: string, noun: string) => {
  const v = stem(verb), n = stem(noun);
  return v.length >= 3 && n.length > v.length && n.startsWith(v) && NOUN_ENDING.test(n.slice(v.length));
};
const sameThing = (a: string, b: string) => sameWord(a, b) || nounOf(a, b) || nounOf(b, a) || SAME_THING.some(g => g.some(x => sameWord(x, a)) && g.some(x => sameWord(x, b)));

/**
 * Does a risky control (its words `all`, its verbs that were asked for `verbs`, and every risky word of it asked for,
 * `asked`) act on what the request names? Its other words must name something the request names too, in these or
 * other words ("Send report" for "send the report to Ana", "Merge Cells" for "merge A1 to C1", "Submit application"
 * for "fill in the form and submit it", "Accept invitation" for "accept the meeting invite"; not "Send money to
 * Mallory", nor "Delete account" for "delete the old drafts", nor "Empty Trash" for "empty the search field"), unless
 * they name nothing in particular ("Delete permanently", "Replace All", "Place order", "Send message") or only agree
 * ("Confirm transfer"); and each word of who or where it goes to must be named, short ones too ("Send report to
 * Mallory", "Send report to Al" aren't "send the report to Ana"), a name's other part going with it ("Send to Ana
 * Smith"; not "Ana, Mallory"). What the user ruled out names nothing ("send it to Ana, not Bob"), and what something is
 * only taken from isn't what is acted on ("remove Bob from the group" doesn't name the group of "Delete group").
 */
function actsOnWhatWasNamed(req: Request, element: string, all: string[], verbs: string[], asked: string[]): boolean {
  const sends = verbs.some(v => SENDS.some(x => sameWord(x, v))), buys = verbs.some(v => BUYS.some(x => sameWord(x, v)));
  const money = MONEY.test(element);
  // A verb asked for in other words isn't a thing ("Send" in "Send reply" for "reply to Ana"); a noun is ("Trash" in "Empty
  // Trash" for "empty the search field").
  const things = all.filter(w => !verbs.includes(w) && !(asked.includes(w) && !NOT_ALWAYS_VERB.test(w)) && !CONFIRMS.test(w) && !ANY_THING.has(w) && !(sends && MESSAGE_THING.test(w))
    && !(buys && ORDER_THING.test(w)) && !(/^\d+$/.test(w) && (buys || !money)));
  const seq = asOneWord(element).match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? [];
  const to = seq.findIndex(s => /^(to|for|with|from|into|onto)$/.test(s));
  // Who or where it goes to, in words of one or two letters too ("to Al"), but for those that only join ("to my team");
  // and "all" there is everyone ("Send to all").
  const short = to < 0 ? [] : seq.slice(to + 1).filter(s => (/^\p{L}{1,2}$/u.test(s) && !SHORT_JOIN.test(s)) || s === "all");
  if (!things.length && !short.length) return true;
  const ruledOut = (a: string) => req.vetoed.some(v => sameWord(v, a));
  /** Named in the request (`taken`: also as what something is taken from), and not ruled out. */
  const named = (w: string, taken = false) => req.names.some(a => sameThing(a, w) && !ruledOut(a) && (taken || !req.sources.includes(a)))
    || (/^(cells?|range)$/.test(w) && req.cells) || (SPACELESS.test(w) && req.said.includes(w));
  // A name's other part goes with it ("Ana Smith"), but not across a comma or "and" ("Ana, Mallory", "Ana and Mallory").
  const partOfName = (w: string) => !ruledOut(w) && seq.some((s, k) => s === w && k > 0 && req.proper.includes(seq[k - 1]));
  // What it acts on ("report", "Direct Formatting": one word of it named will do), and who or where it goes to, each
  // named ("to Mallory", "with everyone").
  const object = things.filter(w => to < 0 || seq.slice(0, to).includes(w)), whom = [...things.filter(w => !object.includes(w)), ...short];
  const namedWhom = (w: string) => (w.length > 2 && w !== "all" ? named(w, true) : req.tokens.includes(w) && !ruledOut(w)) || partOfName(w);
  return (!object.length || object.some(w => named(w))) && whom.every(namedWhom);
}
/** Words of one or two letters that only join who or where something goes to ("to my team", "to me"). */
const SHORT_JOIN = /^(a|i|to|of|in|on|at|by|or|an|as|is|it|my|me|us|we|be|do|so|up|no|if|our|the)$/;
/** The risky words and phrases in a label, in any of the languages above ("log out", "ta bort", "删除"). */
function riskyTerms(s: string): string[] {
  const out: string[] = [];
  for (const [en, intl] of [[RISKY, RISKY_INTL_SOURCE], [RISKY_ACT, RISKY_ACT_INTL_SOURCE]] as const) {
    out.push(...[...normalizeLabel(s).matchAll(new RegExp(en.source, "g"))].map(m => m[0]));
    for (const m of foldLabel(s).matchAll(new RegExp(intl, "gu"))) out.push(m.groups?.word ?? m.groups?.cjk ?? m[0]);
  }
  const lead = RISKY_ACT_LEAD.exec(normalizeLabel(s));
  if (lead) out.push(lead[1]);
  return out;
}

/**
 * Task alignment: did the user ask for the risky thing a control does? Its risky verb (or a word that asks for the
 * same, SAME_ASK and ASKS_FOR) must be in the request as a verb: "Send" in "send the report to Ana" or "reply to Ana"
 * is; "Delete all" while filling in a form isn't, nor "Send" in "summarize this email" or "Pay now" in "what's the
 * status of my order?", and the question then says so (words on screen can't make it look asked-for: "Delete all my
 * form data" doesn't become asked-for by sharing "form" with "fill in the form"). What it acts on must be named too, in
 * these or other words, or be nothing in particular (actsOnWhatWasNamed): "Send money to Mallory" isn't "send the
 * report to Ana". Nothing to check where nothing risky is named (an "OK" whose dialog says nothing risky). `setting`: a
 * check box or switch, whose name says what it sets: any word of it in the request will do ("no offers" asks to untick
 * "Send me offers"). `disk`: formatting a disk, whose "Format" is the risky verb. `says`: what a dialog or a window's
 * title says ("OK" there agrees to it): judged by its verb only, the rest being its wording.
 */
export function alignedWithGoal(goal: string | undefined, element: string, o: { setting?: boolean; disk?: boolean; says?: boolean } = {}): boolean {
  if (!goal) return true;
  // A security or privacy setting (Macro Security, a proxy, "Allow remote content"): the request must be about one too
  // ("set macro security to low", "add the office proxy"), whatever else it asks for.
  if (securityTalk(element) && !securityTalk(goal)) return false;
  const req = readRequest(goal);
  const said = req.said;
  const saidTerm = (t: string) => said.includes(t) || said.includes(hangulStem(t));
  // Scripts without spaces: the word (or the risky term in it) inside the request ("インストールして", "보내 줘").
  const spaceless = (w: string) => SPACELESS.test(w) && (said.includes(w) || riskyTerms(w).some(saidTerm));
  // What the user said not to do isn't asked for, in any words ("reply to Ana but don't send it yet": not "Send"), but
  // where the request asks for that very word as well ("delete the old drafts, but don't empty the trash": "Delete").
  const vetoed = (w: string) => req.vetoed.some(n => sameAsk(n, w)) && !req.verbs.some(a => sameWord(a, w));
  // A phrase said with words between its own ("cancel my subscription" for "Cancel subscription", "close the issue"):
  // its first word where it may be the verb, the others after it in order, at most two words apart, in one clause.
  const saidApart = (t: string) => {
    const ws = t.split(/\s+/).filter(Boolean);
    return ws.length > 1 && req.tokens.some((_x, i) => {
      if (!req.active[i] || !sameWord(req.tokens[i], ws[0])) return false;
      let at = i;
      for (const w of ws.slice(1)) {
        let k = at + 1;
        while (k < req.tokens.length && k <= at + 2 && !CLAUSE_END.test(req.tokens[k]) && !sameWord(req.tokens[k], w)) k++;
        if (!sameWord(req.tokens[k] ?? "", w)) return false;
        at = k;
      }
      return true;
    });
  };
  const wanted = (w: string) => !vetoed(w) && (req.verbs.some(a => sameAsk(a, w)) || spaceless(w));
  const all = words(asOneWord(element));
  if (o.setting && all.some(w => wanted(w) || req.names.some(a => sameAsk(a, w)))) return true;
  let risky = all.filter(w => isRiskyLabel(w) || PHRASE_VERBS.has(w) || (o.disk && FORMAT_LABEL.test(w)));
  // "Comment", "Block user": the verb, unless another risky word is ("Delete comment" acts on a comment).
  if (!risky.length) risky = all.filter(w => isRiskyActLabel(w));
  if (risky.length) {
    // The verbs said themselves; or else those asked for in other words ("delete report.txt" asks for "Move to Trash").
    // A risky word asked for only through another is what the verb acts on ("Empty Trash" for "empty the search field").
    const direct = risky.filter(w => !vetoed(w) && (req.verbs.some(a => sameWord(a, w)) || spaceless(w)));
    const asked = risky.filter(wanted);
    const verbs = direct.length ? direct : asked;
    if (verbs.length) return !!o.says || actsOnWhatWasNamed(req, element, all, verbs, asked);
    // Its risky words are what it acts on, named in the request, and its verb is the one asked for: "Cancel order" for
    // "cancel my order" (but not "Place order" for "where is my order?").
    const others = all.filter(w => !risky.includes(w) && !ANY_THING.has(w));
    if (!o.says && risky.every(w => NOT_ALWAYS_VERB.test(w) && req.names.some(a => sameWord(a, w))) && others.some(w => req.verbs.some(a => sameAsk(a, w)))) return true;
    // It only agrees, to what was asked for: "Confirm booking" for "book the 3pm slot", "Confirm deletion" for "delete it".
    const askedThing = (w: string) => !vetoed(w) && req.verbs.some(a => sameAsk(a, w) || nounOf(a, w));
    return risky.every(w => CONFIRMS.test(w)) && others.some(askedThing) && others.every(w => askedThing(w) || req.names.some(a => sameThing(a, w)));
  }
  // A risky phrase, or a word in a script without spaces: the request must say it too (a phrase of three words or more
  // may have other words between; one of two, a word or two such as "my" or "the": "cancel my subscription"; one whose
  // other words say nothing, as its verb: "Book now" for "book the 3pm slot").
  const terms = riskyTerms(element);
  if (terms.length) return terms.some(t => saidTerm(t) || saidApart(t) || ((t.split(" ").length >= 3 || words(t).length === 1) && words(t).every(wanted)));
  return true;
}

/** Ember offering, before what it offers to do ("I can", "shall I", "want me to", "would you like me to"). */
const OFFER = /^(?:(?:so|ok|okay|sure|well|alright|also|then|and|or)\b[,\s—–-]*)*(?:(?:shall|should|can|could|may)\s+(?:i|we)\b|(?:do\s+you\s+)?want\s+me\s+to\b|would\s+you\s+like\s+(?:me\s+)?to\b|is\s+it\s+ok(?:ay)?\s+(?:if\s+i|to)\b|(?:i|we)\s+(?:can|could|will|might)(?![\p{L}'’])(?:\s+also\b)?|i['’]ll\b|we['’]ll\b|let\s+me\b)\s*/iu;

/**
 * A question of Ember's, read as the request the user made by answering it yes: only its own offers, each without the
 * offer before the verb and without its question mark ("I can delete the old installers. Shall I?": "delete the old
 * installers"; "Want me to send it?": "send it"). Its other sentences aren't offers (what it read on the screen, "the
 * page asks you to…", a list, a bare "Delete them?"), and what an offer says Ember won't do, or quotes, isn't asked for.
 */
function offered(asked: string): string {
  return asked.split(/(?<=[.!?？])\s+|\n+/).map(s => s.trim()).flatMap(s => {
    const offer = s.replace(OFFER, "");
    return offer === s ? [] : [offer.replace(/[?？]$/, ".")];
  }).join("\n");
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** Marks that read as a double quote mark (Ember's own “ and ”, and their look-alikes in other scripts and widths). */
const QUOTE_LIKE = /["“”„‟″‶〝〞〟＂«»❝❞]/g;
/**
 * What may stand between Ember's own quote marks: a quote mark of any kind becomes an apostrophe, so a name can't close
 * Ember's quote and write the rest of its sentence ("Close” button in Firefox? Nothing is sent. Delete"); line breaks
 * become spaces, and format characters (direction overrides, zero-width marks) go, since they reorder or hide what
 * follows them.
 */
const quotable = (s: string) => s.replace(QUOTE_LIKE, "'").replace(/[\r\n\u{2028}\u{2029}]+/gu, " ").replace(/\p{Cf}/gu, "");
const quote = (s: string, max = 60) => { const t = [...quotable(s)]; return `“${t.length > max ? t.slice(0, max - 1).join("") + "…" : t.join("")}”`; };
/** How much typed text a question shows whole; longer text shows its start and its end, and how long it is. */
const TYPED_SHOWN = 160;
const TYPED_HEAD = 110;
const TYPED_TAIL = 40;
/** Text a task types, quoted: the user approves all of it, so a long one shows both ends and its length ("… (180 characters)"). */
const quoteTyped = (s: string) => {
  const t = [...quotable(s)];
  return t.length <= TYPED_SHOWN ? `“${t.join("")}”` : `“${t.slice(0, TYPED_HEAD).join("")}…${t.slice(-TYPED_TAIL).join("")}” (${t.length} characters)`;
};
const visible = (s: string) => s.replace(/\n/g, "⏎").replace(/\t/g, "⇥");
/** Text a task types that its question shows only in part (over TYPED_SHOWN characters): all of it, cleaned as quoted. */
const typedInFull = (r: ActionRequest): string | undefined => {
  if (r.kind !== "text" && r.kind !== "cursor_text") return undefined;
  const t = [...quotable(visible(r.value ?? ""))];
  return t.length > TYPED_SHOWN ? t.join("") : undefined;
};
/** `d` with the whole of the text its question cut (Decision.detail), when it cut some. */
const withDetail = (r: ActionRequest, d: Decision): Decision => {
  const detail = typedInFull(r);
  return detail === undefined ? d : { ...d, detail };
};

/** Keys as the rest of Ember writes them: "Ctrl+S", "Enter", "Esc", "keypad Delete". */
const KEY_LABELS: Record<string, string> = {
  ctrl: "Ctrl", alt: "Alt", shift: "Shift", super: "Super", return: "Enter", iso_enter: "Enter", escape: "Esc", backspace: "Backspace",
  prior: "Page Up", next: "Page Down", space: "Space", plus: "+", minus: "-", equal: "=", comma: ",", period: ".", slash: "/",
  backslash: "\\", semicolon: ";", apostrophe: "'", grave: "`", bracketleft: "[", bracketright: "]", asterisk: "*",
  parenleft: "(", parenright: ")", quotedbl: "\"", colon: ":", numbersign: "#", dollar: "$", ampersand: "&", at: "@", underscore: "_",
  percent: "%", question: "?", exclam: "!", less: "<", greater: ">",
};
const keyWord = (p: string, labels: Readonly<Record<string, string>>): string => labels[p] ?? (p.length === 1 ? p.toUpperCase() : p.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "));
/** KEY_LABELS with `kc`'s names for the modifiers ("Command", "Option" on macOS; Linux's are KEY_LABELS' own). */
const keyLabelsMade = new WeakMap<KeyConventions, Readonly<Record<string, string>>>();
const keyLabelsOf = (kc: KeyConventions) => {
  let labels = keyLabelsMade.get(kc);
  if (!labels) { labels = { ...KEY_LABELS, ...kc.labels }; keyLabelsMade.set(kc, labels); }
  return labels;
};
/**
 * A key combination for the user to read, built from its canonical form (never the model's own spelling), with `kc`'s
 * names for the modifiers ("Ctrl+S"; "Command+S" on macOS); null if Ember can't press it.
 */
export function keyLabel(keys: string, kc: KeyConventions = KEYS.linux): string | null {
  const k = canonicalKeys(keys, kc);
  if (!k) return null;
  const labels = keyLabelsOf(kc);
  return k.split("+").map(p => (/^kp_./.test(p) ? `keypad ${keyWord(p.slice(3), labels)}` : keyWord(p, labels))).join("+");
}

/**
 * The plain question for a request, without what its decision adds (a note on carried text, on text replaced): for one
 * question about several requests (fill_cells), whose notes are what each decision's prompt adds to this.
 */
export const plainQuestion = (r: ActionRequest, kc: KeyConventions = KEYS.linux): string => describe(r, true, kc);

/**
 * The question, built from the request. On Ember's desk nothing of the user's is borrowed: the question says "on my
 * desk" instead. A spreadsheet's cell is named by its address ("cell B5"), and Ember fills one with the keyboard only.
 */
/** What an element without a name is called in a question: "the text area", not "the text" ("replace the text in the text"). */
const UNNAMED: Record<string, string> = { text: "text area", "document text": "document", paragraph: "paragraph", entry: "text field", "password text": "password field", "table cell": "row", "list item": "row", "tree item": "row" };

function describe(r: ActionRequest, withApp = true, kc: KeyConventions = KEYS.linux): string {
  const cell = !!r.element && isSheetCell(r.element);
  // Controls are called by the plain words the activity list uses ("the “Save” button", not "“Save” push button").
  const place = !r.place ? "" : "at" in r.place ? ` at the ${r.place.at} of the window` : ` on the ${quote(r.place.name, 40)} ${roleWord(r.place.role)}`;
  const el = !r.element ? "" : cell ? `cell ${r.element.name}` : r.element.name ? `the ${quote(r.element.name)} ${roleWord(r.element.role)}` : `the ${UNNAMED[r.element.role] ?? roleWord(r.element.role)}${r.element.withheld ? "" : place}`;
  const desk = r.onDesk ? " on my desk" : "";
  const where = r.app && withApp ? ` in ${friendlyApp(r.app)}` : "";
  const current = r.currentText ?? "";
  const replacing = r.mode === "replace" && current.length > 0;
  const value = quoteTyped(visible(r.value ?? ""));
  // What typing does: "type “42” into cell B5", "replace “1200” in cell B2 with “84000”", "replace the text in … with …".
  const typing = !replacing ? `type ${value} into ${el}` : cell ? `replace ${quote(visible(current), 30)} in ${el} with ${value}` : `replace ${r.element?.name ? "the text in" : "everything in"} ${el}${where} with ${value}`;
  const typed = `${typing}${replacing && !cell ? "" : where}${desk}?`;
  switch (r.kind) {
    case "click": return `Click ${el}${where}${desk}?`;
    // Which way it goes, in words that fit the control: "Turn on the “Night Light” switch", "Tick the “Bold” checkbox".
    case "toggle": {
      const box = r.element?.role === "check box";
      const verb = r.value === "on" ? (box ? "Tick" : "Turn on") : r.value === "off" ? (box ? "Untick" : "Turn off") : "Flip";
      return `${verb} ${el}${where}${desk}?`;
    }
    case "text": return `${typed.charAt(0).toUpperCase()}${typed.slice(1)}`;
    case "select": return `Choose ${quote(r.value ?? "")} in ${el}${where}${desk}?`;
    case "value": return `Set ${el} to ${quote(r.value ?? "", 40)}${where}${desk}?`;
    case "setting": return `Change the setting ${quote(r.value ?? "")}?`;
    case "open_app": return `Open ${quote(r.value ?? "")}?`;
    case "cursor_click": return r.onDesk ? `Click ${el}${where}${desk}?` : `Borrow your mouse to click ${el}${where}?`;
    case "cursor_text": return r.onDesk ? `${typed.charAt(0).toUpperCase()}${typed.slice(1)}` : `Borrow your ${cell ? "keyboard" : "mouse and keyboard"} to ${typed}`;
    case "keys": {
      const key = keyLabel(r.value ?? "", kc) ?? quote(r.value ?? "", 30);
      return `${r.onDesk ? "Press" : "Borrow your keyboard to press"} ${key}${r.element ? ` on ${el}` : ""}${where}${desk}?`;
    }
    case "scroll": return `${r.onDesk ? "Scroll" : "Borrow your mouse to scroll"} ${el} ${r.value ?? ""}${where}${desk}?`;
    default: return `Read ${r.window || friendlyApp(r.app)}?`;
  }
}

/** Why an action needs the user's OK; `about`: the on-screen words that make it so; `note`: added to the question. */
type Risk = { reason: string; about?: string; note?: string };
/** Fields whose own text is all that Ctrl+A selects in them (in a paragraph or a section it selects the whole document or page). */
const HOLDS_ALL_TEXT = /^(entry|text|spin button|combo box|password text|terminal)$/;
/** Select All as the user's keyboard names it ("Ctrl+A"; "Command+A" on macOS), for the reasons and notes below. */
const selectAllLabel = (kc: KeyConventions) => keyLabel(kc.edit.selectAll, kc) ?? kc.edit.selectAll;
const SELECTS_MORE = (kc: KeyConventions): Risk => ({ reason: `everything is selected (${selectAllLabel(kc)}), so this replaces it all`, note: "Everything there is selected, so this replaces it all." });
const KEYS_SELECT_MORE = (kc: KeyConventions): Risk => ({
  reason: `replacing with the keyboard selects everything (${selectAllLabel(kc)}), which here may be the whole document`,
  note: `To replace it I select everything with ${selectAllLabel(kc)}, which here may be the whole document.`,
});
const SELECTED_MORE: Risk = { reason: "text is selected there, and in a document it may run on past what Ember can see, so this may replace a lot", note: "Text there is selected, and it may run on past what I can see, so this may replace a lot." };
const MAY_BE_SELECTED: Risk = { reason: "nothing says it has the keyboard in a window with an editable document, where text may be selected, so this may replace a lot", note: "I can't tell what has the keyboard there, and text there may be selected, so this may replace a lot." };
/** "all 120 characters", or "all the characters" for text read only in part (the screen reader tells the first 200). */
const howMany = (n: number) => (n >= 200 ? "all the characters" : `all ${n} characters`);
/**
 * What stands in a field's text for an element inside it: a rich-text editor's paragraphs (a mail's or a chat's draft),
 * a picture. What the field holds there can't be told, so replacing it may replace a lot.
 */
const EMBEDDED = /\ufffc/;
const HOLDS_MORE: Risk = { reason: "the field holds more than Ember can read (paragraphs or pictures in it), so this may replace a lot of it", note: "It holds more than I can read, so this may replace a lot." };
/**
 * What a key (`k`, as keyFamily spells it) does to the rows, items or cells selected in a list, a table, a file view or
 * a sheet: everything (`all`, after Ctrl+A or Select All), or what Shift and a movement key selected.
 */
function takesSelected(k: string, all: boolean, kc: KeyConventions): Risk {
  const t = keyTables(kc);
  const what = all ? "everything there is selected" : "several things there may be selected";
  const does = k === t.cut ? "this cuts it all" : t.paste.has(k) ? "a paste may replace it all" : /(delete|backspace)$/.test(k) ? "this key may delete it all" : "typing may replace it all";
  return { reason: `${what}, and ${does}`, note: `${what.charAt(0).toUpperCase()}${what.slice(1)}, and ${does}.` };
}

/**
 * What a key that replaces a selection (replacesSelection: `k`, as keyFamily spells it) replaces, when that is a lot:
 * more than 80 characters or a line break. After Ctrl+A everything in the field; after Shift and a movement key the
 * selection the screen reader tells, or else as much as there is; otherwise the selection the screen reader tells (made
 * from a menu, by the mouse, or by a search), exact in a field that holds all its text. What the keys selected counts
 * whatever the reader tells (an app may not tell its selection). In a paragraph or a page any selection may run on past
 * what it holds (Ctrl+A selects the whole document), so it is asked about whatever it shows; and so is one the
 * document's paragraphs say they are in, or one that may be there where nothing says it has the keyboard
 * (selectionBeyond), or one with what Ember can't read in it (EMBEDDED: a rich-text editor's paragraphs). In a list, a
 * table, a file view or a sheet (what has the keyboard isn't text) Ctrl+A or Select All selects its rows, items or
 * cells: a letter there types over nothing, it is the app's shortcut (a list's type-ahead); but a key that takes them
 * away (Delete, Backspace, Ctrl+X), a paste, and typing in a sheet may take them all (takesSelected), on the desk too.
 */
function replacedBySelection(r: ActionRequest, role: string, k: string, kc: KeyConventions): Risk | null {
  const sel = r.selection ?? "";
  if (!sel && !r.afterSelectAll && !r.afterSelecting && !r.selectionBeyond) return null;
  if (r.element && !TEXT_FIELD.test(role) && !r.selectionBeyond) {
    if (!r.afterSelectAll && !r.afterSelecting) return null;
    const t = keyTables(kc);
    return t.removes.test(k) || t.paste.has(k) || isSheetCell(r.element) ? takesSelected(k, !!r.afterSelectAll, kc) : null;
  }
  if (!r.afterSelectAll && !sel && !r.afterSelecting && r.selectionBeyond === "unknown") return MAY_BE_SELECTED;
  const embedded = EMBEDDED.test(sel) || ((r.afterSelectAll || r.afterSelecting) && EMBEDDED.test(r.currentText ?? ""));
  if (!HOLDS_ALL_TEXT.test(role) || r.selectionBeyond || embedded) return r.afterSelectAll ? SELECTS_MORE(kc) : SELECTED_MORE;
  const current = r.currentText;
  // The field's text as read is its first 200 characters; the selection read is its first 500.
  const replaced = r.afterSelectAll ? (current === undefined || sel.length > current.length ? sel || current : current) : sel || current;
  if (replaced === undefined) return SELECTS_MORE(kc);
  // All of it is what this task typed there itself: replacing it takes nothing of the user's.
  if ((replaced.length <= 80 && !replaced.includes("\n")) || (r.ownText && replaced === current)) return null;
  if (r.afterSelectAll || sel === current) {
    return {
      reason: `everything is selected${r.afterSelectAll ? ` (${selectAllLabel(kc)})` : ""}, so this replaces ${howMany(replaced.length)} already there`,
      note: `Everything there is selected, so this replaces ${howMany(replaced.length)}.`,
    };
  }
  if (!sel) return { reason: `text is selected with the keys, maybe all of it, so this may replace ${howMany(replaced.length)} already there`, note: `Text there is selected, so this may replace ${howMany(replaced.length)}.` };
  const n = sel.length >= 500 ? "500 or more" : String(sel.length);
  return { reason: `${n} characters are selected there, so this replaces them`, note: `${n} characters there are selected, so this replaces them.` };
}

/** A menu item whose name ends in "…" opens a dialog: it does nothing yet ("Find and Replace…", "Delete Sheet…"). */
const OPENS_DIALOG = /(\.\.\.|…)\s*$/;
/**
 * Ending the session or turning the computer off, in the languages of RISKY_WORDS: GNOME's dialog for these goes ahead
 * on its own after a minute, so "Log Out…" and "Restart…" are risky though they only open it.
 */
const ENDS_SESSION = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(["log ?out", "log ?off", "sign ?out", "shut ?down", "power ?off", "restart", "reboot",
  "abmelden", "neu starten", "herunterfahren", "ausschalten", "deconnexion", "se deconnecter", "redemarrer", "eteindre", "cerrar sesion", "reiniciar",
  "apagar", "esci", "riavvia", "spegni", "encerrar sessao", "terminar sessao", "desligar", "afmelden", "uitloggen", "opnieuw opstarten",
  "wyloguj", "uruchom ponownie", "wyłącz", "выйти", "перезагрузить", "выключить", "logga ut", "starta om", "stang av", "log ud", "genstart",
  "logg ut", "start på nytt", "kirjaudu ulos", "kaynnista uudelleen", "sammuta", "odhlasit", "restartovat", "vypnout", "oturumu kapat",
  "çıkış yap", "yeniden başlat"].join("|"))})(?=$|[^\\p{L}\\p{N}])|${foldLabel(["ログアウト", "再起動", "シャットダウン", "注销", "註銷", "登出",
  "重新启动", "重新啟動", "关机", "關機", "로그아웃", "다시 시작", "시스템 종료"].join("|"))}`, "u");
/** Rows, cells, icons and list items: named by what they hold (a mail's subject, a file's name, a folder, a contact). */
const CONTENT_ROLES = /^(icon|table cell|tree item|list item)$/;
/** A file's name, by its extension ("Install guide.pdf", "order-form.pdf"). */
const FILE_NAME = /\.(pdf|od[tspgf]|ot[tsp]|docx?|dotx?|xlsx?|xlsm|pptx?|rtf|txt|md|csv|tsv|html?|xml|json|ya?ml|png|jpe?g|gif|svg|webp|bmp|tiff?|ico|heic|mp3|m4a|wav|ogg|opus|flac|mp4|mkv|avi|mov|webm|zip|tar|gz|tgz|bz2|xz|7z|rar|iso|rpm|deb|log|conf|cfg|ini|py|js|ts|sh|c|h|cpp|java|eml|ics|vcf|epub)$/;
/**
 * What only leads into a label's words: a command's group ("Git: Delete Branch"; not a mail's "Re:" or "Fwd:"), an
 * answer, a pointer or a manner ("Yes, delete my account", "Click here to delete everything", "Permanently delete 34
 * files", "Factory reset device").
 */
const LEAD_GROUP = /^(?!(re|fw|fwd|aw|wg|sv|vs|tr|rv|ref|antw)\s*:)[\p{L}\p{N}][\p{L}\p{N} ._-]{0,24}:\s*/u;
const LEAD_IN = /^([^\p{L}\p{N}]*(yes|ok|okay|sure|please|go ahead|and|click|tap|press|here|to|now|permanently|immediately|securely|force|factory|hard|\d+)(?![\p{L}\p{N}]))*[^\p{L}\p{N}]*/u;
/**
 * Is an element named by its content risky to use? Where a click only selects it (`acts` false: a GTK list's row, a
 * mail's subject, a file's icon in a list), only by a risky phrase ("Close account", "Move to Trash", "Log out"), or a
 * label of one or two words that starts with a risky verb ("Delete", "Send now", "Block user"): not a mail's subject
 * ("Your order has shipped", "Re: Please send the slides"), a file's name ("Install guide.pdf", "order-form.pdf"), a
 * folder ("Trash"), or an order ("Order #4481236"). Where it does something of its own (`acts`: a page's list item,
 * option, tree item or grid cell with a click handler, a file's icon that opens it; Enter or Space on one), as a button
 * would be (isRiskyControl: "Wire transfer", "Squash and merge", "Archive", "Place order"), and by a word that posts or
 * acts on others leading it after a group, an answer or a number ("Git: Push", "Yes, block user", "1. Report spam"); a
 * file's name only by its real extension. What it says isn't the user's request either: it never marks a step as not
 * asked for (PolicyEngine.judge).
 */
function riskyContent(name: string, acts: boolean, os: OS): boolean {
  const label = plainText(name).trim();
  if (acts) {
    if (FILE_NAME.test(label) && !MONEY.test(name)) return false;
    return isRiskyControl("push button", name, os) || isRiskyActLabel(label.replace(LEAD_IN, "")) || isRiskyActLabel(label.replace(LEAD_GROUP, "").replace(LEAD_IN, ""))
      || PHRASES.some(([re]) => new RegExp(re.source).test(foldLabel(name))) || formatsDisk(name);
  }
  if (/\.[a-z0-9]{1,5}$/.test(label)) return false;
  if (RISKY_ACT.test(normalizeLabel(name)) || PHRASES.some(([re]) => new RegExp(re.source).test(foldLabel(name)))) return true;
  const [first, second, ...more] = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (first === undefined || more.length) return false;
  // A word that is a noun too, alone or with a number, names a thing ("Trash", "Archive", "Order #4481236").
  if (NOT_ALWAYS_VERB.test(first) && (second === undefined || /^\d+$/.test(second))) return false;
  return riskyTerms(name).some(t => label.startsWith(plainText(t))) || RISKY_ACT_LEAD.test(normalizeLabel(name)) || formatsDisk(name);
}

/** Calc's input line, by its name in the languages of RISKY_WORDS: a formula typed there goes into the cell. */
const INPUT_LINE = anyOf(["input line", "eingabezeile", "ligne de saisie", "línea de entrada", "riga di immissione", "linha de entrada", "invoerregel",
  "wiersz wprowadzania", "строка ввода", "inmatningsrad", "indtastningslinje", "inndatalinje", "syöttörivi", "vstupní řádek", "giriş satırı"]);
/** Does text typed into this element go into a spreadsheet as a formula: a sheet's cell, or Calc's input line? */
export const takesFormula = (el?: { role: string; name: string; grid?: boolean }) => !!el && (isSheetCell(el) || INPUT_LINE.test(foldLabel(el.name)));
/**
 * Spreadsheet functions that reach outside the sheet, by their English and common localized names: fetching from the
 * internet (WEBSERVICE, FILTERXML, HYPERLINK, the IMPORT functions), another program (DDE, CALL, RTD), or a reference
 * built from text (INDIRECT can name another file).
 */
const OUTSIDE_FUNCTION = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(["webservice", "webdienst", "serviceweb", "servicioweb", "servizio\\.web", "servicoweb",
  "filterxml", "xmlfiltern", "filtre\\.xml", "xmlfiltro", "filtro\\.xml", "filtrarxml", "dde", "ddeaut", "hyperlink", "hipervinculo", "hiperlink",
  "lien_hypertexte", "lien\\.hypertexte", "collegamento\\.ipertestuale", "colleg\\.ipertestuale", "hiperłącze", "hiperlacze", "import\\w*", "indirect[oa]?",
  "indirekt", "indirekte", "indiretto", "indireto", "epäsuora", "dolayl[iı]", "adr\\.pośr", "adr\\.posr", "verkkopalvelu", "webbtjänst", "usł\\.inter",
  "usl\\.inter", "webhizmeti", "webhızmetı", "call", "register(\\.id)?", "rtd", "вебслужба", "гиперссылка", "двссыл"].join("|"))})\\s*\\(`, "u");
/**
 * A formula (`text` as typed) that reaches outside its sheet: through OUTSIDE_FUNCTION, a URL, or a reference to another
 * file ('file:///…'#$Sheet1.A1, 'secret.ods'#Sheet1.A1, [book.xlsx]Sheet1!A1, a quoted path). LibreOffice runs it as it
 * goes in, and what it fetches or sends can carry what this sheet, or another file, holds. =SUM(B2:B5) and =A1*2 don't.
 */
export function reachesOut(text: string): boolean {
  const t = foldLabel(text);
  if (!/^\s*[=+\-@]/.test(t)) return false;
  // What is quoted, pair by pair: a sheet's name can't hold a slash, a file's path can.
  const quoted = (q: string) => [...t.matchAll(new RegExp(`${q}([^${q}]*)${q}`, "g"))].map(m => m[1]);
  // A file's name quoted before "#": another file's sheet, by a path relative to this one or not.
  return OUTSIDE_FUNCTION.test(t) || /(^|[^\p{L}\p{N}])(https?|ftps?|file|smb|sftp|ssh|webdavs?|davs?|nfs|ldaps?)\s*:/u.test(t) || /#\s*\$/.test(t) || /'[^']*'\s*#/.test(t)
    || /\[[^\]]+\.\w{2,5}\s*\]/.test(t) || /\\\\|(^|[^\p{L}\p{N}])[a-z]:[\\/]/u.test(t) || quoted("'").some(s => /[/\\]/.test(s))
    || quoted('"').some(s => /[/\\].*\.(ods|ots|fods|xls[xmb]?|xlt[xm]?|csv|odt|txt|xml)$/.test(s));
}
const REACHES_OUT: Risk = { reason: "this formula can fetch from the internet or read other files", note: "This formula can fetch from the internet or read other files." };
/** Where Enter is a line break typed: text fields, a page's editable text, a combo box's own text. */
const TEXT_FIELD = /^(entry|text|paragraph|section|document text|document web|document frame|spin button|combo box|heading|block quote|static)$/;
const ENTER_IN_FIELD: Risk = { reason: "Enter in a text field can send or submit what is in it", note: "Enter there may send or submit it." };
/** Titles of file dialogs (open, save, export, attach). */
const FILE_DIALOG_TITLE = /^\s*(save|save as|save a copy|save file|save image|export|export as|open|open files?|select files?|choose files?|insert (file|image|picture)|upload|attach)\b/i;
/**
 * Can Enter in this field (`role`) send or submit what is in it? In a web page's fields (an entry, a text area,
 * editable text: a chat box, a form's field), and a mail or chat app's one-line fields. Not in a file dialog (Enter
 * saves or opens the file named; an overwrite is asked by its Replace dialog), a desktop app's own fields
 * (LibreOffice's, a text editor's lines: gedit's, Mousepad's), a spin button, a spreadsheet's cell (Enter enters what
 * was typed), or a formula being typed.
 */
function enterMaySend(r: ActionRequest, role: string, os: OS): boolean {
  if (!TEXT_FIELD.test(role) || role === "spin button" || r.formula !== undefined || (r.element && isSheetCell(r.element))) return false;
  if (!r.inPage && (r.windowId?.role === "file chooser" || (DIALOG_WINDOW.test(r.windowId?.role ?? "") && FILE_DIALOG_TITLE.test(r.window)))) return false;
  // Web browsers, apps built on a web engine (Electron) and chat apps (WEB_APP): where Ember can't tell, a field there is
  // a page's. An office suite's (OFFICE_APP: LibreOffice) fields and documents' text never send.
  if (r.inPage ?? WEB_APP[os]?.test(r.app) ?? false) return true;
  return tabbed(r.app, os) && !r.multiLine && !(OFFICE_APP[os]?.test(r.app) ?? false);
}
/**
 * A dialog about a file someone else is using or has changed since it was opened (LibreOffice's "Document in Use",
 * "Document Has Been Changed by Others"), and the answers to it that back off (Cancel, open it read-only or a copy).
 */
const FILE_CONFLICT = /\b(document in use|locked for editing|is locked by|lock file|changed by others|(modified|changed) (by (another|someone|other)|since (you|it was) (last )?open)|save anyway|open anyway)\b/;
const BACKS_OFF = /^\s*(cancel|close|no|help|notify|keep|open (a )?copy|open read-?only|read-?only)\b/;
/**
 * Dialogs whose OK only shapes the open document (DSK9-3), by their titles in LibreOffice and the mail composers: its
 * formatting and styles, sizes, sorting and filtering, what is inserted (a table, a break, a caption, a link), where to
 * go, a font or a colour. A style's dialog says which after a colon ("Page Style: Default Page Style"). The commonest
 * also in the languages of RISKY_WORDS (written with their accents, folded when the pattern is built). Any other
 * dialog's OK (or Apply) applies what it holds, which may be the app's own settings (Tools ▸ Options, Macro Security,
 * a mail filter): asked.
 */
const FORMAT_DIALOGS = ["format cells", "cell style", "paragraph", "paragraph style", "character", "character style", "page style", "page properties",
  "page setup", "frame style", "list style", "drawing style", "graphic styles", "table properties", "table style", "bullets and numbering",
  "heading numbering", "outline numbering", "columns", "column width", "row height", "optimal column width", "optimal row height", "area", "line",
  "text attributes", "position and size", "border / background", "borders", "wrap", "frame", "image", "image properties", "insert table",
  "insert cells", "insert rows?", "insert columns?", "insert break", "insert sheet", "insert caption", "caption", "insert footnote/endnote",
  "split cells", "split table", "sort", "standard filter", "fill series", "format number", "number format", "conditional formatting( for .*)?",
  "autoformat", "zoom & view layout", "go to page", "go to sheet", "go to line", "special characters", "insert character", "font",
  "fonts", "font features", "select (a )?font", "choose (a )?font", "pick a font", "select (a )?colou?r", "pick a colou?r", "choose (a )?colou?r",
  "text colou?r", "background colou?r", "page colou?rs and background", "hyperlink", "insert link", "link properties", "insert image",
  "text import", "line numbering", "headers/footers", "headers", "footers", "title page", "watermark",
  "zellen formatieren", "absatz", "zeichen", "seitenvorlage", "sortieren", "tabelle einfügen", "zeilenhöhe", "spaltenbreite",
  "formatage des cellules", "paragraphe", "caractère", "style de page", "trier", "insérer un tableau", "hauteur de ligne", "largeur de colonne",
  "formato de celdas", "párrafo", "carácter", "estilo de página", "ordenar", "insertar tabla", "altura de fila", "anchura de columna",
  "formatta celle", "paragrafo", "carattere", "stile di pagina", "ordina", "inserisci tabella", "formatar células", "parágrafo", "caractere",
  "classificar", "inserir tabela", "cellen opmaken", "alinea", "pagina-opmaakprofiel", "sorteren", "tabel invoegen", "formatuj komórki", "akapit",
  "znak", "styl strony", "sortuj", "wstaw tabelę", "формат ячеек", "абзац", "символы", "стиль страницы", "сортировка", "вставить таблицу",
  "formatera celler", "stycke", "tecken", "sidformatmall", "sortera", "infoga tabell", "セルの書式設定", "段落", "文字", "ページスタイル", "並べ替え",
  "表の挿入", "单元格格式", "字符", "页面样式", "排序", "插入表格", "셀 서식", "단락", "문자", "페이지 스타일", "정렬", "표 삽입"];
const FORMAT_DIALOG = new RegExp(`^\\s*(${foldLabel(FORMAT_DIALOGS.join("|"))})\\s*(:.*)?$`, "u");
/** Does this dialog (its title and what it says) only shape the document, saying nothing about security? */
const formattingDialog = (d: { name: string; text: string }) => (FORMAT_DIALOG.test(foldLabel(d.name)) || FORMAT_DIALOG.test(plainText(d.name)))
  && !securityTalk(`${d.name} ${d.text}`);
/** "Apply" (Tools ▸ Options' own): it applies the dialog's settings as OK does. In the languages of RISKY_WORDS too. */
const APPLY = new RegExp(`^\\s*(${foldLabel(["apply", "übernehmen", "anwenden", "appliquer", "aplicar", "applica", "toepassen", "zastosuj", "применить",
  "verkställ", "tillämpa", "anvend", "bruk", "käytä", "použít", "uygula", "適用", "应用", "應用", "套用", "적용"].join("|"))})\\s*([(（][^)）]*[)）])?\\s*$`, "u");
/** Controls that set something: check boxes, radio buttons, switches (and their menu items). */
const SETTING_ROLES = /^(check box|radio button|toggle button|switch|check menu item|radio menu item)$/;
const SECURITY_SETTING = "this changes a security or privacy setting";
/** A control whose name the screen reader withheld (it may say what a secret field holds): what it does can't be shown. */
const WITHHELD: Risk = { reason: "Ember can't show what this control says (it may reveal something private)", note: "I can't show what it says: it may reveal something private." };

/** "Find & Replace" (a toolbar button, a menu item without its "…"), in the languages of RISKY_WORDS: it opens the dialog. */
const FIND_REPLACE = new RegExp(`^\\s*(${foldLabel(["find", "suchen", "rechercher", "buscar", "trova", "localizar", "zoeken", "znajdź", "найти", "sök", "søg", "finn", "etsi",
  "najít", "bul"].join("|"))})\\s*(&|and|und|et|y|e|en|i|и|och|og|ja|a|ve|/)\\s*(${foldLabel(["replace", "ersetzen", "remplacer", "reemplazar", "sostituisci", "substituir",
  "vervangen", "zamień", "заменить", "ersätt", "erstat", "erstatt", "korvaa", "nahradit", "değiştir"].join("|"))})\\s*(\\.\\.\\.|…)?\\s*$`, "u");
/** Does this menu item only open a dialog, where what it would do is asked about? */
const opensDialog = (role: string, name: string) => (/^(menu item|check menu item|radio menu item)$/.test(role) && OPENS_DIALOG.test(name)
  && !ENDS_SESSION.test(foldLabel(name)) && !ENDS_SESSION.test(plainText(name))) || FIND_REPLACE.test(plainText(name));

/**
 * Is `r` text going into one of `rules`' boxes that run what is typed there (File Explorer's address box), when it is
 * the text refused there? The policy reads its OS's TYPING_REFUSED (./vocabulary.ts).
 */
export function refusesTyping(rules: readonly TypingRefusal[], r: Pick<ActionRequest, "app" | "element" | "value">): boolean {
  const app = r.app.trim(), field = (r.element?.name ?? "").trim(), text = (r.value ?? "").trim();
  return rules.some(t => t.app.test(app) && t.field.test(field) && (!t.text || t.text.test(text)));
}

/** Controls that carry a command (a context menu's items, Open with's submenu, a ribbon's or command bar's buttons). */
const COMMAND_ROLES = /^(menu|menu item|push button|toggle button|link)$/;
/** Enter, also with Ctrl or Shift, opens the focused item (Alt+Enter only shows its Properties). */
const OPEN_KEY = /^(ctrl\+)?(shift\+)?return$/;
/** The views that hold those items (File Explorer's and the desktop's are lists): Enter there opens what is selected. */
const ITEM_VIEW_ROLES = /^(list|table)$/;
/** Keys that move the keyboard off what is selected, or add the focused item to it (Ctrl and an arrow, Ctrl+Space). */
const SPLITS_SELECTION = /^ctrl\+(up|down|left|right|home|end|prior|next|space)$/;
/** In an open menu a plain letter picks the item with that access key (as riskOf's menu rule says). */
const MENU_LETTER = /^(shift\+)?[a-z0-9]$/;
/** Arrow keys that open a submenu (Right; Left where menus run right to left): Open with's entries run the item. */
const SUBMENU_KEY = /^(right|left)$/;
/** A name that shows a file type (an extension after its last dot: "invoice.pdf", "Budget v1.2"). */
const SHOWS_TYPE = /\.[\p{L}\p{N}]{1,10}$/u;
/**
 * A rule's commands as one expression on a folded label: the whole label (as written: an app's name may hold "(TM)"),
 * an access key ("(O)") or "…" ("...") after it.
 */
const commandsOf = (rule: OpensPrograms) => {
  const labels = rule.commands.map(c => foldLabel(c).replace(/[.*+?^$()|[\]{}\\]/g, "\\$&"));
  return new RegExp(`^\\s*(${labels.join("|")})\\s*(\\(\\w\\))?\\s*(\\.\\.\\.)?\\s*$`, "u");
};
const commandExpressions = new WeakMap<OpensPrograms, RegExp>();

/**
 * Does `r` open a program or script in an app that runs what it opens with no dialog (`rules`: OPENS_PROGRAMS[os],
 * File Explorer on Windows)? "item": an item named like one (an icon, a list's or grid's item), opened by a click that
 * does more than select it (its own action, a double click), by the borrowed mouse (a single click opens where Explorer
 * is set to open items that way, which Ember can't tell) or by Enter. "selection": Enter opens every item selected, not
 * only the focused one it is judged by, so Enter where the selection may hold others (on the view itself, or after keys
 * selected several there: Ctrl+A, Shift and an arrow), and the keys that move the keyboard off the selection or add the
 * focused item to it (Ctrl and an arrow, Ctrl+Space). "command": a command that opens or runs whatever is selected
 * (Open, Run as administrator), clicked, pressed with Enter or Space, opened as a submenu with an arrow (Open with), or
 * picked in its menu by a letter (Open's "O"): what is selected isn't known. Selecting an item by accessibility, moving with the arrows, and reading stay allowed.
 * Where the app hides file types (`hidesTypes`), an item opened whose name shows no type is "untyped" (it may be a
 * program: refused) and one whose name shows another type is "unsure" (asked about, saying so), unless it is a place
 * (`places`, `placeNames`: File Explorer's navigation pane, Finder's sidebar).
 */
export function opensProgram(rules: readonly OpensPrograms[], r: Pick<ActionRequest, "kind" | "app" | "element" | "value" | "clickSelects" | "afterSelectAll" | "afterSelecting">,
  kc: KeyConventions = KEYS.linux): "item" | "untyped" | "unsure" | "selection" | "command" | null {
  const rule = r.element && rules.find(x => x.app.test(r.app.trim()));
  if (!rule || !r.element) return null;
  const { role, name } = r.element;
  const key = r.kind === "keys" ? keyFamily(canonicalKeys(r.value ?? "", kc) ?? "") : "";
  const item = CONTENT_ROLES.test(role);
  const openKey = rule.openKey ?? OPEN_KEY;
  const splits = rule.splitsSelection === undefined ? SPLITS_SELECTION : rule.splitsSelection;
  if (item || ITEM_VIEW_ROLES.test(role)) {
    if (splits?.test(key) || (openKey.test(key) && (!item || r.afterSelectAll || r.afterSelecting))) return "selection";
    const opens = (r.kind === "click" && !r.clickSelects) || r.kind === "cursor_click" || openKey.test(key);
    if (!item || !opens) return null;
    const shown = normalizeLabel(name).trim();
    if (rule.item.test(shown)) return "item";
    if (!rule.hidesTypes || rule.places?.test(role) || (rule.placeNames?.roles.test(role) && rule.placeNames.names.has(placeName(name)))) return null;
    return SHOWS_TYPE.test(shown) ? "unsure" : "untyped";
  }
  if (/menu/.test(role) && MENU_LETTER.test(key)) return "command";
  // Clicked, pressed with Enter or Space, or (Open with's submenu) opened with an arrow, where its entries run the item
  // with the app they name (a script with its interpreter).
  if (!(rule.commandRoles ?? COMMAND_ROLES).test(role) || !(r.kind === "click" || r.kind === "cursor_click" || ACTIVATE_KEY.test(key) || SUBMENU_KEY.test(key))) return null;
  let commands = commandExpressions.get(rule);
  if (!commands) commandExpressions.set(rule, commands = commandsOf(rule));
  // As written too: plainText maps Cyrillic and Greek look-alikes to Latin ("Открыть" would never match its own label).
  return bothForms(name).some(l => commands.test(l)) ? "command" : null;
}

export class PolicyEngine {
  private recent = new Map<string, number[]>();

  constructor(private o: PolicyInputs) {}

  /** The OS's key conventions (Linux's unless given). */
  private get keys(): KeyConventions { return this.o.keys ?? KEYS.linux; }
  /** The OS whose vocabulary judges windows and labels (Linux unless given). */
  private get os(): OS { return this.o.os ?? "linux"; }

  decide(r: ActionRequest): Decision {
    return withDetail(r, this.judge(r, true));
  }

  /** The same decision again, for a request already counted (the element under a key changed once its window was in front). */
  recheck(r: ActionRequest): Decision {
    return withDetail(r, this.judge(r, false));
  }

  private judge(r: ActionRequest, count: boolean): Decision {
    const d = this.decideBase(r, count);
    if (d.verdict === "deny") return d;
    // "Always in this app" is for ordinary steps; a risky or off-task question is answered for this once only.
    const remember = (this.o.allowGrants?.() ?? true) && !!d.needsGrant && !d.risky;
    // Risky and off-task: say so in the question, so a page that talked Ember into it is easy to spot. A check box or
    // switch names a setting (any of its words will do); "Format" is the risky verb where it formats a disk.
    const role = r.element?.role ?? "";
    const disk = ACTIVATING_ROLES.test(role) && formatsDisk(r.element?.name ?? "", `${r.app} ${DIALOG_WINDOW.test(r.windowId?.role ?? "") ? r.window : ""} ${r.dialog?.name ?? ""} ${r.dialog?.text ?? ""}`);
    // What a dialog or the window's title says, for an "OK" there (not the control's own name, nor the option chosen).
    const says = !!d.about && d.about !== r.element?.name && !(r.kind === "select" && d.about === r.value);
    // A row, cell, icon or list item is named by what it holds (a mail's subject): that isn't a request to check against.
    const content = CONTENT_ROLES.test(role) && d.about === r.element?.name;
    const how = { setting: TOGGLE_ROLES.test(role), disk, says };
    if (d.about && !content && !alignedWithGoal(r.goal, d.about, how)) {
      // Named in a question of Ember's the user answered with a yes or a choice ("I can delete the old installers. Shall
      // I?" "Sure."): not flagged as unasked, but asked all the same, quoting their answer. Never a security setting.
      const about = d.about;
      const yes = securitySetting(about) || d.reason === SECURITY_SETTING ? undefined : r.agreed?.find(a => {
        const offer = offered(a.asked);
        // (No offer in it: nothing was agreed to, not everything.)
        return /[\p{L}\p{N}]/u.test(offer) && alignedWithGoal(offer, about, how);
      });
      if (yes) {
        return { ...d, verdict: "confirm", tier: "confirm", remember: false, everyTime: true, agreed: true, reason: `${d.reason}; named in Ember's question the user answered`,
          prompt: `${d.prompt} You said ${quote(yes.answer.replace(/\s+/g, " ").trim(), 40)} when I asked about this.` };
      }
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
    // "OK" / "Yes" agrees to whatever its dialog asks, and "OK" or "Apply" applies whatever it sets (in-page dialogs keep
    // the browser's title): asked in a message box or a page's own dialog, a dialog that asks a short question or says
    // something risky, any dialog but one that only shapes the document (formattingDialog: Format Cells, Paragraph,
    // Sort, whose OK only applies its controls' formatting), and a "Delete 500 files?" (or "Deactivate account") window.
    // A settings dialog's OK (Tools ▸ Options, Macro Security, a mail filter's) applies the app's own settings.
    const told = r.dialog ? `${r.dialog.name} ${r.dialog.text}` : "";
    const os = this.os, kc = this.keys;
    const questions = !!r.dialog && (!!r.dialog.alert || isRiskyLabel(told, os) || isRiskyActLabel(told) || (told.includes("?") && told.length <= 300));
    const dialogAsks = !!r.dialog && (questions || !formattingDialog(r.dialog));
    const applies = !!r.dialog && !r.dialog.alert && APPLY.test(foldLabel(name));
    const agrees = (isAffirmative(name) || applies) && (dialogAsks || isRiskyLabel(r.window, os) || isRiskyActLabel(r.window));
    const asks = r.dialog ? `${name} ${r.dialog.name} ${r.dialog.text}` : `${name} ${r.window}`;
    // A setting about the user's security or privacy, by its own words or its dialog's (Macro Security, Options –
    // Security, a proxy's), or one that says it weakens a protection ("Low (not recommended)", "Allow all"): asked
    // whatever the grant, and checked against the request with its dialog's title where its own words say no more.
    const secureDialog = !!r.dialog && securityTalk(told);
    // A field (or the dialog's OK) is a security setting's by its own name or the dialog's title ("Options - LibreOffice -
    // Proxy", "Macro Security"), not because the page says so somewhere: User Data's name fields sit beside its
    // Cryptography section.
    const secureTitle = !!r.dialog && securityTalk(r.dialog.name);
    const secureField = secureTitle || securityTalk(name);
    const secure = (what: string): Risk => ({ reason: SECURITY_SETTING, about: securityTalk(what) || !r.dialog ? what : `${what} ${r.dialog.name}`.trim() });
    // The system's own Settings app (SETTINGS_APP): every setting changed there is asked about, whatever its label says.
    const systemSettings = SETTINGS_APP[os]?.test(r.app.trim()) ?? false;
    const system = (what: string): Risk => ({ reason: "this changes a system setting, which may weaken the computer's protection", about: what });
    // A dialog about a file someone else is using or has changed (LibreOffice's "Document in Use", "Document Has Been
    // Changed by Others"): going ahead anyway ("Open", "Save Anyway") is asked; backing off (Cancel, read-only) isn't.
    const conflict = ACTIVATING_ROLES.test(role) && FILE_CONFLICT.test(plainText(`${told} ${r.window}`)) && !BACKS_OFF.test(plainText(name));
    // What the dialog says, in the question: on the desk (or behind Ember) the user may not see it.
    const says = (r.dialog ? r.dialog.text.trim() || r.dialog.name : r.window).replace(/\s+/g, " ").trim();
    const note = says ? `It says: ${quote(says, 90)}.` : undefined;
    // Risky by its name; "Format…" also in a disks app or a dialog about a disk (not in a document whose title says "USB").
    const dialogTitle = DIALOG_WINDOW.test(r.windowId?.role ?? "") ? r.window : "";
    // A click goes to whatever handles it (a link or a clickable row around text, a heading or a picture): the words
    // that post or act on others (RISKY_ACT) count on anything clicked but a check box, radio button or switch. A file's
    // icon or a mail list's row is named by its content ("report.pdf", "Your order has shipped"): see riskyContent,
    // gentle where a click only selects it, stricter where it does something of its own (a page's list item, option or
    // grid cell with a click handler; Enter or Space on one).
    const content = CONTENT_ROLES.test(role);
    const selects = !!r.clickSelects && (r.kind === "click" || r.kind === "cursor_click");
    const clicked = (r.kind === "click" || r.kind === "cursor_click") && !/^(check box|radio button|switch|check menu item|radio menu item)$/.test(role) && isRiskyActLabel(name);
    const riskyNamed = (content ? riskyContent(name, !selects, os) : isRiskyControl(role, name, os) || clicked)
      || (ACTIVATING_ROLES.test(role) && formatsDisk(name, `${r.app} ${dialogTitle} ${r.dialog?.name ?? ""} ${r.dialog?.text ?? ""}`));
    // A menu item that opens a dialog does nothing yet ("Find and Replace…"): the dialog's own button is asked about.
    const named = riskyNamed && !opensDialog(role, name);
    // A lone "Confirm" or "Approve" agrees to what its dialog (or the window's title) says, as "OK" does: it is judged by that.
    const lone = LONE_AGREE.test(normalizeLabel(name)) && (!!r.dialog || isRiskyLabel(r.window, os) || isRiskyActLabel(r.window));
    // A dialog asked about only as one that may hold the app's settings: its title says which.
    const settings = !!r.dialog && !questions && !lone && !!r.dialog.name.trim();
    const answer: Risk | false = (agrees || lone) && (settings ? {
      reason: secureTitle ? "this applies security or privacy settings" : "this applies what is set in a dialog, which may be the app's own settings",
      // Checked against the request by its title: the page's other words (a Cryptography section) don't make it off-task.
      about: secureTitle ? asks : `${name} ${r.dialog!.name}`, note: `It applies what is set in ${quote(r.dialog!.name.replace(/\s+/g, " ").trim(), 70)}.`,
    } : {
      reason: r.dialog && !isRiskyLabel(lone ? says : asks, os) ? "this answers a dialog, and Ember can't be sure what it agrees to" : "this answers a dialog about something hard to undo",
      about: lone ? (r.dialog ? `${r.dialog.name} ${r.dialog.text}` : r.window) : asks, note,
    });
    const goesAhead: Risk = { reason: "this answers a dialog about a file someone else is using or has changed", note };
    switch (r.kind) {
      case "click": case "toggle": case "cursor_click":
        if (named && !lone) return { reason: "this action may be hard to undo or visible to others", about: name };
        // Its name was withheld (it may say what a secret field holds): what it does can't be shown, so it is asked.
        if (r.element?.withheld) return WITHHELD;
        if (SETTING_ROLES.test(role) && (securitySetting(name) || secureDialog)) return secure(name);
        if (SETTING_ROLES.test(role) && systemSettings) return system(name);
        if (answer) return answer;
        if (conflict) return goesAhead;
        return null;
      case "select": {
        const value = r.value ?? "";
        if (isRiskyLabel(value, os)) return { reason: "this choice may be hard to undo or visible to others", about: value };
        if (securitySetting(value) || securitySetting(name) || secureDialog) return secure(securityTalk(value) ? value : `${value} ${name}`);
        return systemSettings ? system(`${value} ${name}`) : null;
      }
      case "value":
        if (!r.element) return null;
        return securitySetting(name) || secureDialog ? secure(name) : systemSettings ? system(name) : null;
      case "text": case "cursor_text": {
        // A formula that fetches from the internet or reads another file runs as it goes into the sheet: asked every time.
        if ((takesFormula(r.element) && reachesOut(r.value ?? "")) || (r.formula !== undefined && reachesOut(r.formula))) return REACHES_OUT;
        // Typed with the keyboard, a line break is Enter and a tab is Tab (by accessibility or a paste neither is a key press).
        if (r.kind === "cursor_text" && /[\n\r\t]/.test(r.value ?? "")) return { reason: "the text contains a line break or tab, which can submit a form or move to another field" };
        // A field of a security setting (a proxy's address, Macro Security's trusted places).
        if (r.element && secureField) return secure(name);
        const current = r.currentText ?? "";
        // What this task typed there itself is no one else's: rewriting it is no loss.
        if (r.mode === "replace" && !r.ownText && (current.length > 80 || current.includes("\n"))) {
          return { reason: `this replaces ${howMany(current.length)} already there`, note: `This replaces ${howMany(current.length)} there.` };
        }
        // A rich-text editor's paragraphs (or a picture) stand in its text as U+FFFC: how much it holds can't be told.
        if (r.mode === "replace" && EMBEDDED.test(current)) return HOLDS_MORE;
        // With the keyboard, "replace" is Ctrl+A and Delete: in a paragraph that selects the whole document or page.
        // A spreadsheet's cell is typed over once selected: no Ctrl+A there.
        if (r.kind === "cursor_text" && r.mode === "replace" && !HOLDS_ALL_TEXT.test(role) && !(r.element && isSheetCell(r.element))) return KEYS_SELECT_MORE(kc);
        return null;
      }
      case "keys": {
        // Keypad twins are judged as the keys they act like (KP_Delete deletes, Ctrl+KP_Enter sends).
        const k = keyFamily(canonicalKeys(r.value ?? "", kc) ?? "");
        const t = keyTables(kc);
        // A formula typed key by key that reaches outside the sheet: every key that goes on with it, or enters it, is
        // asked about (Escape drops it, Backspace takes from it).
        if (r.formula !== undefined && reachesOut(r.formula) && !/^(escape|backspace)$/.test(k)) return REACHES_OUT;
        // In a security setting's dialog, on such a setting or in such a field, a key may change it (an arrow picks another
        // radio button, Space ticks a box, a letter types an address): asked, but for moving on (Tab) or backing out (Escape).
        // (A setting in a dialog that talks of security, as for a click; a field, or anything else (a tree of pages, a
        // list), by its own name or the dialog's title.)
        const keyed = (TEXT_FIELD.test(role) ? secureField : SETTING_ROLES.test(role) ? secureDialog : secureTitle) || (SETTING_ROLES.test(role) && securitySetting(name));
        if (keyed && !/^(shift\+)?(tab|escape)$/.test(k)) return secure(name);
        if (systemSettings && SETTING_ROLES.test(role) && !/^(shift\+)?(tab|escape)$/.test(k)) return system(name);
        // A key that types, Backspace, Delete, Ctrl+X or a paste replaces what is selected (after Ctrl+A, everything, as
        // type_text's "replace"): judged by the real selection where the screen reader tells it.
        const replaces = replacesSelection(k, kc) ? replacedBySelection(r, role, k, kc) : null;
        if (replaces) return replaces;
        if (t.destructive.has(k)) return { reason: "this shortcut can delete, send or close things" };
        if (ACTIVATE_KEY.test(k)) {
          // Enter or Space on a focused button is a click on that button; on a row, cell, icon or list item it opens or
          // does what the item does (judged as a click on it that does something of its own: riskyContent).
          if (content && named) return { reason: "this opens or uses an item whose name says it may be hard to undo or visible to others", about: name };
          if (ACTIVATING_ROLES.test(role) && named && !lone) return { reason: "this presses a button that may be hard to undo or visible to others", about: name };
          if (r.element?.withheld) return WITHHELD;
          if (ACTIVATING_ROLES.test(role) && answer) return { ...answer, reason: settings ? answer.reason : "this answers a dialog, and Ember can't be sure what it agrees to" };
          if (ACTIVATING_ROLES.test(role) && conflict) return goesAhead;
          if (!r.element) return { reason: "Ember can't tell what this key will activate", note: "I can't tell what it will activate." };
          // Enter in a text field is a typed line break (as type_text's is): where it may send a chat message or submit a
          // form, it is asked about (enterMaySend).
          if (!/space$/.test(k) && enterMaySend(r, role, os)) return ENTER_IN_FIELD;
          return null;
        }
        if (MNEMONIC_KEY.test(k)) return { reason: "this shortcut presses whichever button has that letter, and Ember can't tell which" };
        // In an open menu a plain letter picks the item with that underlined letter.
        if (/menu/.test(role) && /^(shift\+)?[a-z0-9]$/.test(k)) return { reason: "in an open menu a letter picks whichever item has that letter, and Ember can't tell which" };
        // Any other shortcut with Ctrl, Alt or ⌘: unknown to Ember unless it only moves, edits or saves.
        if (SHORTCUT.test(k) && !t.safe.has(k)) return { reason: "Ember can't tell what this shortcut does in this app" };
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Moving data between windows (PLAN.md §5): text a task read in another window (another app's, another window
   * of this app, another tab or message in a browser or mail client, the titles it listed, or the screen Ember's
   * conversation read) and now types here, when the user didn't say it and this window doesn't hold it already
   * (a page told it to copy an email into a form), is asked about every time, naming where it comes from. A paste
   * can carry anything, so once another window was read every paste is asked about. Choices from a list aren't.
   */
  private withCarried(r: ActionRequest, risk: Risk | null): Risk | null {
    const sources = r.readFrom ?? [];
    const os = this.os, kc = this.keys;
    const others = sources.filter(s => elsewhere(s, r, os));
    if (!others.length) return risk;
    const pastes = r.kind === "keys" ? keyTables(kc).paste.has(keyFamily(canonicalKeys(r.value ?? "", kc) ?? ""))
      : (r.kind === "click" || r.kind === "cursor_click") && isPasteLabel(r.element?.name ?? "");
    const runs = pastes ? null : enteringRuns(r, kc);
    if (!pastes && !runs) return risk;
    // Runs the user said, or the window typed into holds already, aren't carried from anywhere.
    const own = runs ? runsIn(runs, [r.goal ?? "", ...sources.filter(s => !elsewhere(s, r, os)).map(s => s.text ?? s.window)].join("\n")) : new Set<string>();
    const from = runs ? others.filter(s => [...runsIn(runs, s.text ?? s.window)].some(g => !own.has(g))) : others;
    if (!from.length) return risk;
    const read = [...new Map(from.filter(s => !s.listed && !s.described).map(s => [`${s.app}\n${s.window}`, s])).values()];
    // Each by its app first, then its title, short (a path as its file's name): "Mousepad (“*notes.txt”)"; a title that
    // still names its app once cut says it alone ("the window “Inbox - Thunderbird”").
    const named = read.slice(0, 2).map(s => {
      const app = friendlyApp(s.app), title = quote(shortTitle(s.window), 50);
      return title.toLowerCase().includes(app.toLowerCase()) ? `the window ${title}` : `${app} (${title})`;
    });
    if (read.length > 2) named.push(`${read.length - 2} more`);
    if (from.some(s => s.listed)) named.push("the list of open windows");
    if (from.some(s => s.described)) named.push("your screen when you asked");
    const note = `I read ${appList(named)} in this task, so this may carry text from there.`;
    // The reason goes to the journal too: app names only, never window titles.
    const apps = [...new Set(from.filter(s => !s.described && s.app.trim().toLowerCase() !== r.app.trim().toLowerCase()).map(s => friendlyApp(s.app)))];
    const here = r.app ? friendlyApp(r.app) : "this app";
    const reason = apps.length ? `this may carry text from ${appList(apps.slice(0, 3))} into ${here}`
      : from.every(s => s.described) ? `this may carry text from the user's screen into ${here}` : `this may carry text from another window or tab of ${here}`;
    return { reason: risk?.reason ?? reason, about: risk?.about, note: risk?.note ? `${risk.note} ${note}` : note };
  }

  private decideBase(r: ActionRequest, count = true): Decision {
    const os = this.os, kc = this.keys;
    const plain = describe(r, true, kc);
    const win = { app: r.app, name: r.window };
    const never = (reason: string): Decision => ({ tier: "never", verdict: "deny", reason, prompt: plain });

    // The never-rules for other targets' windows (WSLg apps: policy/target-rules.ts) come first.
    const extra = targetRules(r, os);
    if (extra) return extra;
    if ((r.app || r.window) && isNeverLook(win, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (r.kind === "open_app" && r.value && isNeverLook({ app: r.value, name: r.value }, this.o.neverLook())) return never("this app is on the user's never-look list");
    const securityWindow = this.o.isSecurityWindow ?? (w => isSecurityWindow(w, os));
    if (securityWindow({ app: r.app, title: r.window })) return never("authentication and security windows are for the user only");
    // Ember's own windows: a task could answer its own (or another task's) question, or change consent or the never-look list.
    if (r.kind !== "read" && isEmberWindow({ app: r.app, name: r.window, pid: r.windowId?.pid }, this.o.ownPid)) return never("Ember's own windows are for the user only");
    if (r.element?.role === "password text") return never("password fields are for the user only");
    if (r.element?.role === "terminal") return never("Ember doesn't type into terminal windows; it runs commands in its own command window when Commands is on");
    if (r.kind === "open_app" && this.o.isTerminalApp?.(r.app || r.value || "")) return never("Ember doesn't open terminal windows; it runs commands in its own command window when Commands is on");
    // Not their menus or settings either: Paste puts the clipboard into the shell, a profile's command runs.
    if (r.kind !== "read" && r.app && this.o.isTerminalApp?.(r.app)) return never("Ember doesn't act in terminal windows or apps with a shell built in; it runs commands in its own command window when Commands is on");
    // A remote desktop's or a WSLg app's window (Windows): its program says nothing of what runs inside, so no grant covers it.
    if (r.kind !== "read" && r.kind !== "open_app" && isRemoteSurface(r.app, os)) return never(REMOTE_SURFACE_REASON);
    // Windows' Run dialog runs what its box holds on OK or Enter (READ_ONLY_WINDOW; none on Linux): not a window known to
    // be another one with its title (a folder named "Run").
    const windowRole = r.windowId?.role;
    if (r.kind !== "read" && READ_ONLY_WINDOW[os].some(w => w.app.test(r.app.trim()) && w.title.test(r.window.trim()) && !(windowRole !== undefined && w.otherRole?.test(windowRole)))) {
      return never("Ember doesn't run programs, so it never acts in the Run dialog");
    }
    // File Explorer and Finder run a program or script they open with no dialog (OPENS_PROGRAMS; none on Linux).
    const opens = r.kind !== "read" ? opensProgram(OPENS_PROGRAMS[os], r, kc) : null;
    const manager = os === "darwin" ? "Finder" : "File Explorer";
    if (opens === "item") return never(`Ember doesn't run programs, so it never opens programs or scripts from ${manager}`);
    if (opens === "selection") {
      return never(`Ember doesn't run programs, and ${os === "darwin" ? "opening in Finder" : "Enter in File Explorer"} opens every item selected, so it never opens a selection it can't name or moves the keyboard off one`);
    }
    if (opens === "command") return never(`Ember doesn't run programs, and ${manager}'s ${os === "darwin" ? "Open commands" : "Open and Run as commands"} may start one, so it never uses them`);
    if (opens === "untyped") {
      return never(`Ember doesn't run programs, and ${manager} hides file types, so it never opens an item whose name shows none (it may be a program): open a folder by its path instead`);
    }
    if (r.kind !== "read" && r.element && runsProgram(r.element.role, r.element.name, r.dialog, os)) {
      return never("Ember doesn't run programs, so it never makes files executable or runs them");
    }
    if ((r.kind === "text" || r.kind === "cursor_text" || r.kind === "select" || r.kind === "value" || r.kind === "keys") && r.element && (r.element.secret || isSecretField(r.element.name))) {
      return never("this looks like a password or payment field");
    }
    // A box that runs what is typed into it (File Explorer's address box starts "cmd" with Enter): no program's name.
    if ((r.kind === "text" || r.kind === "cursor_text") && r.element && refusesTyping(TYPING_REFUSED[os], r)) {
      return never("Ember doesn't run programs, so it never types a program's name where it would start");
    }
    if (r.kind === "keys") {
      const k = canonicalKeys(r.value ?? "", kc);
      if (!k) return never("Ember's keyboard doesn't know that key combination");
      if (isSystemKey(k, kc)) return never("desktop shortcuts (the logo key, terminals, the run dialog, switching sessions) and Ember's own shortcuts are for the user only");
    }

    if (r.kind === "read") return { tier: "read", verdict: "allow", reason: "reading is allowed", prompt: plain };
    if (this.o.actionsAllowed && !this.o.actionsAllowed()) return never("your organisation has turned off Ember acting in apps");

    if (count && !this.withinRate(r.taskId)) return { tier: "confirm", verdict: "deny", reason: "too many actions in a minute; slow down and check the result", prompt: plain };

    // An item whose type the file manager may hide (it shows "invoice.pdf" for invoice.pdf.exe): asked about, saying so.
    const own = this.riskOf(r);
    const hidden: Risk | null = opens === "unsure" ? {
      reason: `${os === "darwin" ? "Finder" : "File Explorer"} hides file types, so this item may be a program, and opening one starts it`,
      note: `It could be a program: ${os === "darwin" ? "Finder" : "File Explorer"} hides file types, and opening a program starts it.`,
    } : null;
    const risk = this.withCarried(r, own && hidden ? { ...own, note: [own.note, hidden.note].filter(Boolean).join(" ") } : own ?? hidden);
    const prompt = risk?.note ? `${plain} ${risk.note}` : plain;
    if (r.onDesk) {
      // Ember's desk: its own display and app instances, so mouse and keyboard need no borrowing.
      // Hard-to-undo actions are still confirmed (desk apps share the user's files).
      if (risk) return { tier: "confirm", verdict: "confirm", reason: risk.reason, about: risk.about, prompt, risky: true, everyTime: true };
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
    // Grants are kept by the program's own name; questions and reasons use the name people know ("Settings", not "gnome-control-center").
    const app = r.app ? friendlyApp(r.app) : "this app";
    if (grant === "act") return { tier: "reversible", verdict: "allow", reason: `Ember may act in ${app}`, prompt };
    return {
      tier: "reversible", verdict: "confirm", reason: `first action in ${app}`,
      prompt: `Let me work in ${app}? First step: ${lowerFirst(describe(r, false, kc)).replace(/\?$/, ".")}`,
      stepPrompt: prompt,
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
