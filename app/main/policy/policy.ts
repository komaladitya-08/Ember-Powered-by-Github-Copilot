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
import { friendlyApp } from "../../shared/apps";

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
  /** For keys: the last keys pressed here were Ctrl+A, so this one may replace everything selected. */
  afterSelectAll?: boolean;
  /** The dialog the element sits in (its title and text): "OK" there agrees to what the dialog says. */
  dialog?: { name: string; text: string };
  /** On Ember's own desk (its private display): no app grant needed, full input allowed. */
  onDesk?: boolean;
  /** What the user asked for, in their own words (for the task-alignment check). */
  goal?: string;
  /** The window acted in, as perception names it, when known. */
  windowId?: WindowId;
  /** Windows this task has read (or seen listed): text typed or pasted into another window may carry what was read there. */
  readFrom?: ReadSource[];
}

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
  /** Ember's own process (default: this one): a task never acts in Ember's own windows. */
  ownPid?: number;
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
const RISKY = /\b(send|post|submit|publish|share|delete|remove|erase|discard|overwrite|replace|empty|buy|pay|order|purchase|checkout|install|uninstall|upload|transfer|reply|forward|sign|accept|approve|confirm|authori[sz]e|grant|trust|merge|run|execute|reset|clear|archive|revoke|unsubscribe|trash|wipe|destroy|quit|close without saving|don't save|log ?out|sign ?out|shut ?down|restart|reboot|power off|kill|terminate|end process|force stop|donate|book now|deploy|subscribe|leave (the )?(group|chat|conversation|meeting|team|channel))\b/;

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
 * change a shared repository. Risky on a button, link or menu item only: a "Comments" heading or tab, or a
 * "Block selection" check item, isn't one. English verbs that are nouns too count where they lead the label
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

/** Words risky only as the whole label: Korean "바꾸기" is GTK's Replace button, but also part of "이름 바꾸기" (Rename). */
const RISKY_WHOLE = new RegExp(`^\\s*(${foldLabel(["바꾸기"].join("|"))})\\s*([(（][^)）]*[)）])?\\s*$`, "u");
export const isRiskyLabel = (s: string) => RISKY.test(normalizeLabel(s)) || RISKY_INTL.test(foldLabel(s)) || RISKY_WHOLE.test(foldLabel(s)) || formatsDisk(s);
/** Is activating this control hard to undo or visible to others: a risky label, or one that posts or acts on others (RISKY_ACT) on a button, link or menu item? */
export const isRiskyControl = (role: string, name: string) => isRiskyLabel(name) || (ACTING_CONTROL.test(role) && isRiskyActLabel(name));

/** Ember's own windows by app or title (settings, the overlay and its bubble, Ask Ember, the desk's view, the microphone helper). */
const EMBER_WINDOW = /^(ember|ember overlay|ask ember|ember's desk|ember microphone)$/;
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
/** The letter or digit a key types (lower case), " " for the space bar, or null for any other key or shortcut. */
export function typedChar(keys: string): string | null {
  const k = keyFamily(canonicalKeys(keys) ?? "");
  const m = /^(shift\+)?([a-z0-9])$/.exec(k);
  return m ? m[2] : /^(shift\+)?space$/.test(k) ? " " : null;
}
/** Keys (without Ctrl or Alt) that type nothing: they move the caret, switch modes or are modifiers themselves. */
const TYPES_NOTHING = /^(shift\+)?(escape|up|down|left|right|home|end|prior|next|insert|menu|pause|print|break|f\d{1,2}|caps_lock|num_lock|scroll_lock|(shift|control|alt|super|meta|hyper)_[lr]|iso_level3_shift|mode_switch|sys_req|xf86\w+)$/;
/** Keys that move the caret (a Ctrl+A selection ends there). */
export const MOVES_CARET = /(^|\+)(up|down|left|right|home|end|prior|next)$/;
/**
 * Does this key type a character (a letter, digit, symbol or Space, with or without Shift)? Shortcuts with Ctrl, Alt or
 * Super, and keys that edit, move or switch (Enter, Tab, Backspace, Delete, arrows, F-keys) don't; neither does
 * anything Ember's keyboard wouldn't understand as a key (it may be text).
 */
export function typesCharacter(keys: string): boolean {
  const k = canonicalKeys(keys);
  if (k === null) return true;
  const f = keyFamily(k);
  return !/(^|\+)(ctrl|alt|super)\+/.test(f) && !TYPES_NOTHING.test(f) && !/^(shift\+)?(return|tab|backspace|delete)$/.test(f);
}
/**
 * Does this key, with everything selected (Ctrl+A), replace all of it? Any key that types (letters, digits, symbols,
 * Space, Enter, Tab), Backspace, Delete, Ctrl+X and the paste keys do.
 */
export function replacesSelection(keys: string): boolean {
  const k = keyFamily(canonicalKeys(keys) ?? "");
  if (!k) return false;
  if (PASTE_KEYS.has(k) || k === "ctrl+x" || k === "shift+delete") return true;
  return !/(^|\+)(ctrl|alt|super)\+/.test(k) && !TYPES_NOTHING.test(k);
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
/** Apps whose window shows one page, message or chat after another, its title saying which: there another title is another place. */
const TABBED_APP = /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|thunderbird|evolution|geary|claws|mail|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram/i;
/** Did the task read `s` somewhere other than where `r` acts: another app, another window, or (in a browser or mail client) another tab or message? */
function elsewhere(s: ReadSource, r: ActionRequest): boolean {
  if (s.described || s.app.trim().toLowerCase() !== r.app.trim().toLowerCase()) return true;
  const w = r.windowId ?? {};
  if (s.pid != null && s.pid === w.pid && (DIALOG_WINDOW.test(s.role ?? "") || DIALOG_WINDOW.test(w.role ?? ""))) return false;
  const known = s.pid != null && w.pid != null && !!s.path && !!w.path;
  if (known && (s.pid !== w.pid || s.path !== w.path)) return true;
  if (s.window.trim() === r.window.trim()) return false;
  // The same window under another title (or one Ember can't tell apart but by its title).
  return !known || TABBED_APP.test(r.app);
}
/** Letters and digits in a row that make a run of text recognisably from somewhere (shorter ones are everyday coincidences). */
const RUN = 12;
/** Each line folded (foldLabel would make line breaks spaces), the lines kept apart by "\n": runs and numbers stay within a line. */
const fold = (s: string) => s.split(/[\n\r]+/).map(foldLabel).join("\n");
/** Each line's letters and digits, folded ("Re: Layoff list" → "relayofflist"), the lines kept apart by "\n". */
const compact = (s: string) => fold(s).split("\n").map(l => l.replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean).join("\n");
/** Separators within a number (dashes of any kind, the minus sign, slash, dot, comma, apostrophe, plus). */
const NUMBER_SEPARATORS = "-\\u2010-\\u2015\\u2212/.,'+";
/**
 * What may stand between the digits of one number: spaces and brackets, with at most one separator among them
 * ("84,000", "448 812", "84'000", "123-45-6789", "+1 (555) 123-4567", "12/03/1985").
 */
const NUMBER_GAP = new RegExp(`(\\d)(?:[ ()]{1,2}(?:[${NUMBER_SEPARATORS}][ ()]{0,2})?|[${NUMBER_SEPARATORS}][ ()]{0,2})(?=\\d)`, "g");
/** Numbers of five digits or more in folded text (fold), however they are written ("84,000" → "84000", "123-45-6789" → "123456789"). */
const numbersOf = (folded: string) => folded.replace(NUMBER_GAP, "$1").match(/\d{5,}/g) ?? [];
/** A digit at most a NUMBER_GAP away from the end (or the start) of a text: a number there can go on past it. */
const DIGIT_BEFORE = new RegExp(`\\d[${NUMBER_SEPARATORS} ()]{0,5}$`);
const DIGIT_AFTER = new RegExp(`^[${NUMBER_SEPARATORS} ()]{0,5}\\d`);

/** What makes text recognisable: RUN letters and digits in a row, and numbers of five digits or more. */
interface Runs { grams: Set<string>; numbers: Set<string> }
/** A run within one line (compact keeps lines apart: text on two lines is no run, it is two). */
const addGram = (out: Set<string>, g: string) => { if (!g.includes("\n")) out.add(g); };
const gramsOf = (c: string, out = new Set<string>()) => { for (let i = 0; i + RUN <= c.length; i++) addGram(out, c.slice(i, i + RUN)); return out; };
const runsOf = (s: string): Runs => ({ grams: gramsOf(compact(s)), numbers: new Set(numbersOf(fold(s))) });
/** The runs `text` holds too. */
function runsIn(runs: Runs, text: string): Set<string> {
  const found = new Set<string>();
  if (runs.grams.size) for (const g of gramsOf(compact(text))) if (runs.grams.has(g)) found.add(g);
  if (runs.numbers.size) {
    const numbers = numbersOf(fold(text));
    for (const n of runs.numbers) if (numbers.some(m => m.includes(n))) found.add(n);
  }
  return found;
}

/** Text around the place a number may continue through: enough for any number written out. */
const NUMBER_CONTEXT = 40;
/**
 * The runs the text in a field has once `value` goes into `before` (at its end, or `anywhere` when the caret is
 * unknown) and didn't have before: the value's own, and the ones it makes with the text on either side of it.
 */
function addedRuns(before: string, value: string, anywhere: boolean): Runs {
  const cb = compact(before), cv = compact(value), fb = fold(before), fv = fold(value);
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

/**
 * What text going into a field is judged by: all of it when it replaces everything (type_text's "replace", a key
 * after Ctrl+A); otherwise its runs that are new there, with what the field holds now on either side of it (after it
 * for "append"; anywhere for "insert" and keys, the caret being unknown), and after what this task typed there before
 * (`typed`), so text typed in pieces is judged as a whole. Null when nothing is typed.
 */
function enteringRuns(r: ActionRequest): Runs | null {
  const text = r.kind === "text" || r.kind === "cursor_text";
  const now = text ? r.value ?? "" : r.kind === "keys" ? typedChar(r.value ?? "") ?? "" : "";
  if (!now) return null;
  if (text ? (r.mode ?? "replace") === "replace" : r.afterSelectAll) return runsOf(now);
  const runs = r.currentText !== undefined ? addedRuns(r.currentText, now, !text || r.mode === "insert") : runsOf(now);
  const typed = r.typed ?? "";
  const prior = typed.endsWith(now) ? typed.slice(0, typed.length - now.length) : typed;
  if (prior) {
    const more = addedRuns(prior, now, false);
    for (const g of more.grams) runs.grams.add(g);
    for (const n of more.numbers) runs.numbers.add(n);
  }
  return runs;
}

const STOP = new Set(["the", "and", "for", "with", "this", "that", "all", "now", "you", "your", "button", "item"]);
const words = (s: string) => foldLabel(s).match(/[\p{L}\p{N}]{3,}/gu)?.filter(w => !STOP.has(w)) ?? [];
/** Scripts written without spaces between words. */
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A Korean verb's stem without the "-기" that makes it a button's noun ("보내기" → "보내", as in "보내 줘"). */
const hangulStem = (t: string) => (/\p{Script=Hangul}{2,}기$/u.test(t) ? t.slice(0, -1) : t);
/** Rough stem, so "deleting", "deleted" and "delete" match. */
const stem = (w: string) => w.replace(/(ing|ed|es|s|e)$/, "");
/** The same word, roughly: one stem, or one starts the other ("invia" and "inviare", "lösche" and "löschen"). */
const sameWord = (a: string, b: string) => {
  const x = stem(a), y = stem(b);
  return x === y || (Math.min(x.length, y.length) >= 5 && (x.startsWith(y) || y.startsWith(x)));
};
/** Phrases that say one risky thing in several words, as one word: in the request and on the control alike. */
const PHRASES: [RegExp, string][] = [
  [/\b(move|send|put|throw|drag)( (it|them|this|these|that|those|the files?|the folders?|everything))? (to|in|into) (the )?(trash|bin|wastebasket|rubbish bin)\b/g, " trash "],
  [/\b(throw (it |them |this |these |that |those )?away|get rid of)\b/g, " trash "],
  [/\b(log ?(me |us |you |him |her |them )?(out|off)|sign ?(me |us |you |him |her |them )?out)\b/g, " logout "],
  [/\b(shut ?down|power ?off)\b/g, " shutdown "],
];
const asOneWord = (s: string) => PHRASES.reduce((t, [re, w]) => t.replace(re, w), foldLabel(s));
/** Words that ask for the same thing: "delete report.txt" asks for "Move to Trash", "remove row 5" for "Delete Rows", "sign me out" for "Log Out". */
const SAME_ASK = [["delete", "remove", "erase", "trash", "discard", "wipe", "purge", "clear", "empty"], ["uninstall", "remove", "delete"], ["replace", "overwrite"],
  ["send", "submit"], ["quit", "exit", "close"], ["restart", "reboot"]];
const sameAsk = (a: string, b: string) => sameWord(a, b) || SAME_ASK.some(g => g.some(x => sameWord(x, a)) && g.some(x => sameWord(x, b)));
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
 * Task alignment: does a risky control's name share a word with what the user
 * asked for? "Send" in "send the report to Ana" does; "Delete all" while filling in
 * a form doesn't, and the question then says so (words on screen can't make it look asked-for).
 * When the control's name has a risky verb, that verb itself must be in the request:
 * "Delete all my form data" doesn't become asked-for by sharing "form" with "fill in the form".
 */
export function alignedWithGoal(goal: string | undefined, element: string): boolean {
  if (!goal) return true;
  const asked = words(asOneWord(goal));
  const said = `${normalizeLabel(goal)} ${foldLabel(goal)} ${asOneWord(goal)}`;
  const saidTerm = (t: string) => said.includes(t) || said.includes(hangulStem(t));
  // Scripts without spaces: the word (or the risky term in it) inside the request ("インストールして", "보내 줘").
  const wanted = (w: string) => asked.some(a => sameAsk(a, w)) || (SPACELESS.test(w) && (said.includes(w) || riskyTerms(w).some(saidTerm)));
  const all = words(asOneWord(element));
  let risky = all.filter(w => isRiskyLabel(w));
  // "Comment", "Block user": the verb, unless another risky word is ("Delete comment" acts on a comment).
  if (!risky.length) risky = all.filter(w => isRiskyActLabel(w));
  if (risky.length) {
    if (!risky.some(wanted)) return false;
    // The verb is what the user asked for; what it acts on must be too ("Send money to…" isn't "send the report").
    const rest = all.filter(w => !risky.includes(w));
    return rest.length === 0 || rest.some(wanted);
  }
  // A risky phrase, or a word in a script without spaces: the request must say it too (a phrase of three words or more
  // may have other words between: "close my notes without saving" asks for "Close without Saving").
  const terms = riskyTerms(element);
  if (terms.length) return terms.some(t => saidTerm(t) || (t.split(" ").length >= 3 && words(t).every(wanted)));
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
  const where = r.app && withApp ? ` in ${friendlyApp(r.app)}` : "";
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
    default: return `Read ${r.window || friendlyApp(r.app)}?`;
  }
}

/** Why an action needs the user's OK; `about`: the on-screen words that make it so; `note`: added to the question. */
type Risk = { reason: string; about?: string; note?: string };
/** Fields whose own text is all that Ctrl+A selects in them (in a paragraph or a section it selects the whole document or page). */
const HOLDS_ALL_TEXT = /^(entry|text|spin button|combo box|password text|terminal)$/;
const SELECTS_MORE: Risk = { reason: "everything is selected (Ctrl+A), so this replaces it all", note: "Everything there is selected, so this replaces it all." };
const KEYS_SELECT_MORE: Risk = { reason: "replacing with the keyboard selects everything (Ctrl+A), which here may be the whole document", note: "To replace it I select everything with Ctrl+A, which here may be the whole document." };

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
    // "Delete 500 files?" (or "Deactivate account") window to that window's question.
    const agrees = isAffirmative(name) && (!!r.dialog || isRiskyLabel(r.window) || isRiskyActLabel(r.window));
    const asks = r.dialog ? `${name} ${r.dialog.name} ${r.dialog.text}` : `${name} ${r.window}`;
    // What the dialog says, in the question: on the desk (or behind Ember) the user may not see it.
    const says = (r.dialog ? r.dialog.text.trim() || r.dialog.name : r.window).replace(/\s+/g, " ").trim();
    const note = says ? `It says: ${quote(says, 90)}.` : undefined;
    // Risky by its name; "Format…" also in a disks app or a dialog about a disk (not in a document whose title says "USB").
    const dialogTitle = DIALOG_WINDOW.test(r.windowId?.role ?? "") ? r.window : "";
    const riskyNamed = isRiskyControl(role, name) || (ACTIVATING_ROLES.test(role) && formatsDisk(name, `${r.app} ${dialogTitle} ${r.dialog?.name ?? ""} ${r.dialog?.text ?? ""}`));
    switch (r.kind) {
      case "click": case "toggle": case "cursor_click":
        if (riskyNamed) return { reason: "this action may be hard to undo or visible to others", about: name };
        if (agrees) return { reason: r.dialog && !isRiskyLabel(asks) ? "this answers a dialog, and Ember can't be sure what it agrees to" : "this answers a dialog about something hard to undo", about: asks, note };
        return null;
      case "select":
        return isRiskyLabel(r.value ?? "") ? { reason: "this choice may be hard to undo or visible to others", about: r.value } : null;
      case "text": case "cursor_text": {
        // Typed with the keyboard, a line break is Enter and a tab is Tab (by accessibility or a paste neither is a key press).
        if (r.kind === "cursor_text" && /[\n\r\t]/.test(r.value ?? "")) return { reason: "the text contains a line break or tab, which can submit a form or move to another field" };
        const current = r.currentText ?? "";
        if (r.mode === "replace" && (current.length > 80 || current.includes("\n"))) return { reason: `this replaces all ${current.length >= 200 ? "the" : current.length} characters already there` };
        // With the keyboard, "replace" is Ctrl+A and Delete: in a paragraph that selects the whole document or page.
        if (r.kind === "cursor_text" && r.mode === "replace" && !HOLDS_ALL_TEXT.test(role)) return KEYS_SELECT_MORE;
        return null;
      }
      case "keys": {
        // Keypad twins are judged as the keys they act like (KP_Delete deletes, Ctrl+KP_Enter sends).
        const k = keyFamily(canonicalKeys(r.value ?? "") ?? "");
        // After Ctrl+A, a key that types, Backspace, Delete, Ctrl+X or a paste replaces everything selected (as type_text's "replace").
        if (r.afterSelectAll && replacesSelection(k)) {
          const current = r.currentText;
          // In a paragraph Ctrl+A selects the whole document or page, not only what the paragraph holds.
          if (current === undefined || !HOLDS_ALL_TEXT.test(role)) return SELECTS_MORE;
          if (current.length > 80 || current.includes("\n")) return { reason: `everything is selected (Ctrl+A), so this replaces all ${current.length >= 200 ? "the" : current.length} characters already there` };
        }
        if (DESTRUCTIVE_KEYS.has(k)) return { reason: "this shortcut can delete, send or close things" };
        if (ACTIVATE_KEY.test(k)) {
          // Enter or Space on a focused button is a click on that button.
          if (ACTIVATING_ROLES.test(role) && riskyNamed) return { reason: "this presses a button that may be hard to undo or visible to others", about: name };
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
   * Moving data between windows (PLAN.md §5): text a task read in another window (another app's, another window
   * of this app, another tab or message in a browser or mail client, the titles it listed, or the screen Ember's
   * conversation read) and now types here, when the user didn't say it and this window doesn't hold it already
   * (a page told it to copy an email into a form), is asked about every time, naming where it comes from. A paste
   * can carry anything, so once another window was read every paste is asked about. Choices from a list aren't.
   */
  private withCarried(r: ActionRequest, risk: Risk | null): Risk | null {
    const sources = r.readFrom ?? [];
    const others = sources.filter(s => elsewhere(s, r));
    if (!others.length) return risk;
    const pastes = r.kind === "keys" ? PASTE_KEYS.has(keyFamily(canonicalKeys(r.value ?? "") ?? ""))
      : (r.kind === "click" || r.kind === "cursor_click") && isPasteLabel(r.element?.name ?? "");
    const runs = pastes ? null : enteringRuns(r);
    if (!pastes && !runs) return risk;
    // Runs the user said, or the window typed into holds already, aren't carried from anywhere.
    const own = runs ? runsIn(runs, [r.goal ?? "", ...sources.filter(s => !elsewhere(s, r)).map(s => s.text ?? s.window)].join("\n")) : new Set<string>();
    const from = runs ? others.filter(s => [...runsIn(runs, s.text ?? s.window)].some(g => !own.has(g))) : others;
    if (!from.length) return risk;
    const read = [...new Map(from.filter(s => !s.listed && !s.described).map(s => [`${s.app}\n${s.window}`, s])).values()];
    const named = read.slice(0, 2).map(s => { const app = friendlyApp(s.app); return `the window ${quote(s.window, 50)}${s.window.toLowerCase().includes(app.toLowerCase()) ? "" : ` (${app})`}`; });
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
    const plain = describe(r);
    const win = { app: r.app, name: r.window };
    const never = (reason: string): Decision => ({ tier: "never", verdict: "deny", reason, prompt: plain });

    if ((r.app || r.window) && isNeverLook(win, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (r.kind === "open_app" && r.value && isNeverLook({ app: r.value, name: r.value }, this.o.neverLook())) return never("this app is on the user's never-look list");
    if (isSecurityWindow({ app: r.app, title: r.window })) return never("authentication and security windows are for the user only");
    // Ember's own windows: a task could answer its own (or another task's) question, or change consent or the never-look list.
    if (r.kind !== "read" && isEmberWindow({ app: r.app, name: r.window, pid: r.windowId?.pid }, this.o.ownPid)) return never("Ember's own windows are for the user only");
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
    // Grants are kept by the program's own name; questions and reasons use the name people know ("Settings", not "gnome-control-center").
    const app = r.app ? friendlyApp(r.app) : "this app";
    if (grant === "act") return { tier: "reversible", verdict: "allow", reason: `Ember may act in ${app}`, prompt };
    return {
      tier: "reversible", verdict: "confirm", reason: `first action in ${app}`,
      prompt: `Let me work in ${app}? First step: ${lowerFirst(describe(r, false)).replace(/\?$/, ".")}`,
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
