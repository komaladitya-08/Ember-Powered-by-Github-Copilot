/**
 * What the user turned down in one task, kept so that it isn't tried again (CLAUDE.md "After a deny or “Not now”, Ember
 * never retries or works around it"; round nine's tasks-approvals-r9-1 and commands-remote-r9-8). Until this, that rule
 * was only words to the model: the same click sent again in its next reply was asked again (and done on a yes), a
 * refused command's card came up a second and a third time, and where a mode reviews or announces instead of asking,
 * the repeat would have gone ahead. A worker keeps one of these for its task and the command flow reads the same one.
 *
 * Two standings. "refused": the user said no (a "Not now", a deny, a Stop during a command's countdown); it holds for
 * the rest of the task, and the way back is a new request, which is a new task. "waiting": the question ran out of time
 * unanswered, which is nobody's no (cause 10 of the investigation of the owner's report of 2026-11-12) but must not nag
 * either: the step isn't asked about again until the user next says something to the task (`userSpoke`). A repeat of
 * either is refused without a question, never reviewed and never announced. This only tightens: nothing here lets a
 * step go ahead. Plain data and pure functions, no Electron.
 */

import { RISKY_ACT_WORDS, RISKY_WORDS, foldLabel, normalizeLabel, type ActionKind } from "./policy";
import type { DangerClass, Finding } from "../commands/types";
import type { OS } from "../../shared/shortcuts";

/** How a step stands with the user: turned down, or asked about and left unanswered. */
export type Standing = "refused" | "waiting";

/**
 * Kinds that are one step to the user whichever way Ember takes it: a click by accessibility, with the borrowed mouse
 * or as a toggle presses the same control, and text goes into the same field typed or set.
 */
const WAY: Readonly<Record<ActionKind, string>> = {
  read: "read", click: "press", cursor_click: "press", toggle: "press", text: "type", cursor_text: "type", select: "choose", value: "set",
  keys: "keys", scroll: "scroll", setting: "setting", open_app: "open", vault_fill: "fill",
};

/** An app step as its question was about it. */
export interface StepAsked {
  kind: ActionKind;
  /** The worker's stepKey(): the step's window and its element's role and name. */
  key: string;
  /** The element has a role (something is known to be acted on): only then can keys count as pressing it. */
  named: boolean;
  /** The keys pressed, the app opened or the setting changed (what the step is, where no element says it). */
  value?: string;
  /** Keys that work the control that has the keyboard (Enter, Space): the same step as a click on it. */
  activates?: boolean;
}

/**
 * The names a step goes by in a task's refusals: one refused under any of them is the same step. A control is one step
 * however it is pressed (so Enter on a refused button is that button's click, and the other way round); a field is one
 * step whatever would be typed into it (typing other words there is working around the no); keys are the step they
 * are in the element that has the keyboard; an app opened or a setting changed is named by itself, not by a window.
 */
export function stepNames(s: StepAsked): string[] {
  const value = (s.value ?? "").trim().toLowerCase();
  if (s.kind === "open_app" || s.kind === "setting") return [`${WAY[s.kind]}\n${value}`];
  if (s.kind === "keys") return [`keys\n${s.key}\n${value}`, ...(s.activates && s.named ? [`press\n${s.key}`] : [])];
  return [`${WAY[s.kind]}\n${s.key}`];
}

/**
 * What a risky step does, read from the words policy found it risky for: sending, deleting, paying… After a no, a later
 * risky step of a kind the user turned down is that step done another way (Ctrl+Enter or "Send Now" for a refused Send,
 * the Delete key or "Remove" for a refused "Move to Trash", Send in a second compose window), refused for the rest of
 * the task without a question, a check or an announcement (modes-x9s-3). Narrow on purpose: a kind is one thing to
 * the user ("Reset zoom" is no "Replace all", "Block user" no "Close account", "Don't save" a discard), since whatever
 * shares a kind with a refused step is refused silently (evalfix-1). Matched on the label as policy reads it
 * (normalizeLabel), as whole words in the forms that name the act ("Send", "Sending…", "Removes"): never a word that
 * only begins like one ("Postpone", "Blockquote", "Shared drive", "Order by date", "Exit full screen": modes-y9-8;
 * Spanish "quitar" removes, Turkish "paylaş" shares). Emptying and clearing delete ("Empty Trash", "Clear history":
 * evalfix-x9-2), as policy's own risky words have them.
 */
const DOES: readonly (readonly [string, RegExp])[] = [
  ["send", /\b(send(s|ing)?|sent|post(s|ing)?|submit(s|ting)?|publish(es|ing)?|shar(e|es|ing)|repl(y|ies|ying)|forward(s|ing)?|upload(s|ing)?|tweet(s|ing)?|invit(e|es|ing)|deploy(s|ing)?)\b/],
  ["delete", /\b(delet(e|es|ing)|remov(e|es|ing|al)|trash|eras(e|es|ing)|discard(s|ing)?|wip(e|es|ing)|destroy(s|ing)?|format|uninstall(s|ing)?|purg(e|es|ing)|unsubscrib(e|es|ing)|empt(y|ies|ying)|clear(s|ing)?|don't save|without saving|wastebasket|rubbish bin|recycle bin|move to (the )?bin)\b/],
  ["pay", /\b(pay(s|ing|ments?)?|paid|buy(s|ing)?|purchas(e|es|ing)|order(s|ing)?(?! by\b)|checkout|check out|donat(e|es|ing)|transfer(s|ring)?|subscrib(e|es|ing)|billing)\b/],
  ["install", /\b(install(s|ing)?|updat(e|es|ing)|upgrad(e|es|ing)|download(s|ing)?)\b/],
  ["sign-out", /\b(sign ?out|log ?out|sign off|log off|disconnect(s|ing)?)\b/],
  ["overwrite", /\b(overwrit(e|es|ing)|replac(e|es|ing))\b/],
  ["reset", /\b(revert(s|ing)?|reset(s|ting)?|restor(e|es|ing))\b/],
  ["close", /\b(close(s)?|quit(s|ting)?|exit(s|ing)?(?! full\b))\b/],
  ["leave", /\bleav(e|es|ing)\b/],
  ["block", /\b(block(s|ing)?|ban|banned|banning)\b/],
  ["security", /\b(security|protection|firewall|passwords?|permissions?|privacy|unsafe)\b/],
];
/**
 * The same kinds in the languages policy reads risky words in, taken from policy's own lists (RISKY_WORDS and
 * RISKY_ACT_WORDS): each language's stems pick, from that language's entries, the ones that are of a kind, and a label
 * is of that kind when it holds one of those entries as policy matches them (whole words, accents folded). So a kind
 * is known only where policy itself knows the step is risky by that word, and a refused "Senden" is "Jetzt senden",
 * "Absenden" and Ctrl+Enter, as a refused Send is in English. Words policy lists that are no kind here (confirming,
 * accepting, running, merging, archiving, restarting, commenting, declining…) have none, as in English.
 */
const STEMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  fr: { send: "envoy|envoie|soumett|répond|transfér|partag|publi|télévers|invit|tweet", delete: "supprim|suppression|effac|retir|enlev|vide|corbeille|désinstall|se désabonn|ne pas enregistrer|sans enregistrer",
    pay: "command|achet|pay|s'abonn", install: "install", "sign-out": "déconn", overwrite: "remplac|écras", reset: "réinitialis", close: "quitter|fermer", block: "bloquer|bannir" },
  de: { send: "send|absend|versend|abschick|verschick|einreich|übermitt|antwort|weiterleit|teilen|freigeb|veröffentlich|hochlad|einlad|twitter|tweet",
    delete: "lösch|loesch|entfern|leer|in den papierkorb|verwerf|deinstallier|abbestell|nicht speichern|ohne speichern|ohne zu speichern",
    pay: "kauf|bestell|zahlungspflichtig|bezahl|jetzt zahlen|überweis|abonnier", install: "installier", "sign-out": "abmeld|auslogg", overwrite: "ersetz|überschreib", reset: "zurücksetz",
    close: "beenden|konto schließen", block: "blockier|bannen|verbann" },
  es: { send: "envi|respond|reenv|compart|public|publique|subir|invit|tuit", delete: "elimin|borr|suprim|quit|vaci|papelera|descart|desinstal|darse de baja|no guardar|sin guardar",
    pay: "compr|pedido|pag|transf|suscribirse", install: "instal", "sign-out": "cerrar sesión|desconect", overwrite: "reemplaz|reemplac|sustitu|sobrescrib|sobreescrib", reset: "restablec|revertir",
    close: "salir|cerrar \\(", block: "bloquear|banear" },
  it: { send: "invia|spedi|rispond|inoltr|condivid|pubblic|carica file|invita|twitt", delete: "elimin|cancell|rimuov|svuot|cestin|scart|disinstall|non salvare|senza salvare",
    pay: "acquist|comprare|ordina ora|effettua|pag|bonifico|iscriviti", install: "install", "sign-out": "disconnetti|esci", overwrite: "sostitu|sovrascriv", reset: "reimpost|ripristina",
    close: "chiudi", block: "blocca|banna" },
  pt: { send: "envie|responda|encaminh|compartilh|partilh|convid|tuit", delete: "exclu|apag|deletar|remov|esvazi|lixeira|não salvar|não guardar|sem salvar|sem guardar",
    pay: "compr|pedido|pague|transfira|inscrever-se", "sign-out": "sessão", overwrite: "substitu|sobrescrev", reset: "redefin|reverter|restaurar", close: "sair|\\(encerrar\\|fechar\\)", block: "bloquear|banir" },
  nl: { send: "verzend|verstu|indien|beantwoord|antwoorden|doorstur|delen|publice|uitnodig|nodig uit|tweet", delete: "verwijder|leegmaken|prullenbak|verwerp|de-installer|niet opslaan|zonder opslaan",
    pay: "kopen|koop|bestel|afreken|betal|betaal|overmak|overboek", install: "installe", "sign-out": "afmeld|uitlogg", overwrite: "vervang|overschrijv", reset: "resetten|opnieuw instellen|terugdraai",
    close: "afsluiten|account \\(sluiten", block: "blokker|verbann" },
  pl: { send: "wyślij|wysłać|odpowiedz|przekaż|udostępnij|opublikuj|zaproś|tweetuj", delete: "usuń|usunąć|skasuj|opróżnij|odrzuć|do kosza|odinstaluj|nie zapisuj|bez zapisywania",
    pay: "kup|zamów|zamawiam|zapłać|płacę|przelew", install: "zainstaluj", "sign-out": "wyloguj", overwrite: "zastąp|nadpis", reset: "resetuj|zresetuj", close: "zamknij konto", block: "zablokuj|zbanuj" },
  ru: { send: "отправ|послать|ответ|переслать|перешли|подели|опублик|приглас|твитнуть", delete: "удал|убрать|очист|в корзину|не сохранять|без сохранения|отписаться",
    pay: "купи|оформить заказ|заказать|закажи|оплат|заплатить", install: "установ", "sign-out": "выйти|выход", overwrite: "замен|перезаписать", reset: "сброс|откатить", close: "закрыть аккаунт",
    block: "заблокир|забанить" },
  sv: { send: "skicka|svara|vidarebefordra|publicera|bjud in|tweeta", delete: "ta bort|radera|töm papperskorgen|till papperskorgen|avinstallera|spara inte|utan att spara",
    pay: "köp|beställ|betala", install: "installera", "sign-out": "logga ut", overwrite: "ersätt|skriv över", reset: "återställ", close: "\\(avsluta\\|stäng", block: "blockera|bannlys" },
  da: { send: "svar|videresend|inviter|invitér", delete: "slet|fjern|tøm|i papirkurven|afinstaller|gem ikke|uden at gemme", pay: "køb|bestil|betal", install: "installer", "sign-out": "log ud",
    overwrite: "erstat|overskriv", reset: "nulstil", close: "\\(luk", block: "bloker|udeluk" },
  nb: { send: "inviter", delete: "slett|i papirkurven|avinstaller|ikke lagre|uten å lagre", pay: "kjøp|bestill", "sign-out": "logg ut", overwrite: "erstatt|overskriv", reset: "tilbakestill",
    close: "\\(avslutt\\|lukk", block: "blokker|utesteng" },
  fi: { send: "lähetä|vastaa|välitä|jaa|julkaise|kutsu|twiittaa", delete: "poista|tyhjennä|roskakoriin|älä tallenna|tallentamatta", pay: "osta|tilaa nyt|maksa", install: "asenna", "sign-out": "kirjaudu ulos",
    overwrite: "korvaa", reset: "nollaa", close: "sulje tili", block: "estä" },
  cs: { send: "odeslat|odešli|odpovědět|přeposlat|sdílet|publikovat|zveřejnit|pozvat|tweetnout", delete: "smazat|smaž|odstranit|odstraň|do koše|odinstalovat|neukládat|bez uložení",
    pay: "koupit|objednat|zaplatit", install: "nainstalovat|instalovat", "sign-out": "odhlásit", overwrite: "nahradit|přepsat", reset: "resetovat|vrátit změny", close: "zavřít účet",
    block: "zablokovat|blokovat|zabanovat" },
  tr: { send: "gönder|yanıtla|cevapla|ilet|paylaş|yayınla|davet et|tweetle", delete: "sil|kaldır|boşalt|çöpe taşı|kaydetme", pay: "satın al|sipariş ver|ödeme|havale", install: "yükle",
    "sign-out": "çıkış yap|oturumu kapat", overwrite: "üzerine yaz", reset: "sıfırla", close: "\\(hesabı\\|hesabımı\\) kapat", block: "engelle|yasakla" },
};
/** Scripts without spaces between words: policy's own entries (RISKY_ANYWHERE, RISKY_ACT_ANYWHERE) of each kind, matched anywhere. */
const ANYWHERE: Readonly<Record<string, readonly string[]>> = {
  send: ["送信", "返信", "転送", "共有", "公開", "投稿", "招待", "ツイート", "发送", "發送", "提交", "回复", "回覆", "转发", "轉發", "分享", "共享", "发布", "發佈", "發布", "发表", "發表",
    "邀请", "邀請", "전송", "보내기", "제출", "답장", "전달", "공유", "게시", "초대", "트윗"],
  delete: ["削除", "消去", "破棄", "保存しない", "保存せず", "空にする", "ゴミ箱", "清空", "清除", "비우기", "删除", "刪除", "移除", "放弃", "放棄", "不保存", "回收站", "废纸篓", "廢紙簍", "卸载", "卸載", "삭제", "제거", "저장 안 함",
    "저장하지 않", "휴지통"],
  pay: ["購入", "注文", "決済", "支払", "振込", "送金", "购买", "購買", "下单", "下單", "结算", "結算", "支付", "付款", "转账", "轉帳", "汇款", "匯款", "구매", "구입", "주문", "결제", "이체", "송금"],
  install: ["インストール", "安装", "安裝", "설치"],
  "sign-out": ["ログアウト", "サインアウト", "注销", "註銷", "登出", "로그아웃"],
  overwrite: ["置き換え", "置換", "上書き", "替换", "替換", "覆盖", "覆蓋", "모두 바꾸기", "찾아 바꾸기", "덮어쓰기"],
  reset: ["リセット", "初期化", "リバート", "重置", "回滚", "回滾", "초기화"],
  close: ["終了", "退出", "关闭账户", "關閉帳戶", "关闭账号", "종료"],
  block: ["ブロック", "追放", "拉黑", "屏蔽", "封锁", "封鎖", "封禁", "차단", "추방", "강퇴"],
};
/** One expression a kind, built once: policy's entries of that kind as policy matches them, and the scripts without spaces. */
const DOES_INTL: readonly (readonly [string, RegExp])[] = (() => {
  const entries = new Map<string, string[]>();
  for (const [lang, kinds] of Object.entries(STEMS)) {
    const listed = [...(RISKY_WORDS[lang] ?? []), ...(RISKY_ACT_WORDS[lang] ?? [])];
    for (const [kind, stems] of Object.entries(kinds)) {
      const of = new RegExp(`(^|[^\\p{L}\\p{N}])(${foldLabel(stems)})`, "u");
      entries.set(kind, [...(entries.get(kind) ?? []), ...listed.filter(e => of.test(foldLabel(e)))]);
    }
  }
  const kinds = [...new Set([...entries.keys(), ...Object.keys(ANYWHERE)])];
  return kinds.map(kind => {
    const words = entries.get(kind) ?? [];
    const parts = [...(words.length ? [`(^|[^\\p{L}\\p{N}])(${foldLabel(words.join("|"))})(?=$|[^\\p{L}\\p{N}])`] : []), ...(ANYWHERE[kind]?.length ? [foldLabel(ANYWHERE[kind].join("|"))] : [])];
    return [kind, new RegExp(parts.join("|"), "u")] as const;
  });
})();
/** The kinds `words` (a control's name, a choice, what a dialog asks) name. */
const kindsOf = (words: string): string[] => {
  const label = normalizeLabel(words), folded = foldLabel(words);
  return [...new Set([...DOES.filter(([, re]) => re.test(label)), ...DOES_INTL.filter(([, re]) => re.test(folded))].map(([k]) => k))];
};
/**
 * Policy's reasons that themselves say what the step may do, whatever its control is called and in any language: a
 * shortcut that can delete, send or close, Enter or a line break that can send what a field holds, a symbol that
 * stands for sending or deleting, a security or system setting, a step past a warning, a control of a payment page.
 * No other reason gives a kind: its words say where the step is or why Ember doubts it ("this answers a dialog's
 * question or warning…" is no security setting, "…so this replaces it all" no Replace button; evalfix-1). The
 * sentences are policy.ts's, word for word (refused-other-step.test.ts holds them to it); a reason may go on after one.
 */
const REASON_DOES: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^this shortcut can delete, send or close things/, ["delete", "send", "close"]],
  [/^Enter in a text field can send or submit what is in it/, ["send"]],
  [/^the text contains a line break or tab, which can submit a form or move to another field/, ["send"]],
  [/^this button has only a symbol for a name, one that may send, confirm or delete/, ["send", "delete"]],
  [/^this changes a security or privacy setting/, ["security"]],
  [/^this applies security or privacy settings/, ["security"]],
  [/^this changes a system setting, which may weaken the computer's protection/, ["security"]],
  [/^this goes past a warning or turns a protection off/, ["security"]],
  [/^this is in a window whose title mentions [a-z ]+, where it may pay for something/, ["pay"]],
  [/^this closes a tab/, ["close"]],
];
const RISK = "risk\n";
/** A risky step as policy decided it: its control's name, the words that make it risky (Decision.about) and why (its reason). */
export interface RiskAsked {
  name: string;
  about: string;
  reason: string;
  /** The app the step is in: a kind is one thing in one app (a no to Delete in Files is no word on Delete in Mail). */
  app?: string;
  /** The keys pressed, for a shortcut: which of "delete, send or close" this one does. */
  keys?: string;
}
/** What the shortcut policy calls destructive does, by its last key: Delete and Backspace delete, Enter sends, W, Q and F4 close. */
function shortcutKinds(keys: string | undefined): readonly string[] {
  const key = (keys ?? "").trim().toLowerCase().split("+").pop() ?? "";
  return /^(delete|backspace)$/.test(key) ? ["delete"] : /^(return|enter)$/.test(key) ? ["send"] : /^(w|q|f4)$/.test(key) ? ["close"] : ["delete", "send", "close"];
}
/**
 * What a risky step does: `said` by the words policy found it risky for, `why` by policy's reason where that says what
 * the step may do (REASON_DOES). By the words: the control's own name where that names a kind (a dialog's "Discard"
 * discards, whatever the dialog goes on to say), else all of them (a "Yes" is what its dialog asks, a choice what was
 * chosen); never a name policy found nothing risky in (the field a shortcut is pressed in). A shortcut that "can
 * delete, send or close things" does the one its key does, where the key says (modes-y9-8: a no to Ctrl+W refused a
 * later Send). A step whose words name no kind has none (evalfix-1).
 */
export function riskKinds(s: RiskAsked): { said: string[]; why: string[] } {
  const own = s.name.trim() && s.about.startsWith(s.name) ? kindsOf(s.name) : [];
  const said = !s.about.trim() ? [] : own.length ? own : kindsOf(s.about);
  const why = REASON_DOES.filter(([re]) => re.test(s.reason)).flatMap(([re, kinds]) => (re === REASON_DOES[0][0] ? shortcutKinds(s.keys) : kinds));
  return { said, why: [...new Set(why)] };
}
const inApp = (prefix: string, kind: string, app: string | undefined) => `${prefix}${kind}${app?.trim() ? `\n${app.trim().toLowerCase()}` : ""}`;
/**
 * The names a risky step goes by besides its own (stepNames): one for each thing it does, in its app. A kind is bound
 * to the app: the same kind of thing in another app is another thing (modes-y9-8), and a later one there is judged as
 * any step of a task the user said no in.
 */
export function riskNames(s: RiskAsked): string[] {
  const { said, why } = riskKinds(s);
  return [...new Set([...said, ...why])].map(k => inApp(RISK, k, s.app));
}
const RISK_OFF_TASK = "risk-off-task\n";
/**
 * The names a risky step the user didn't ask for is refused under (policy's `aligned: false` at the no: a step a page
 * or the model came up with), instead of riskNames: a no to that is no word on the user's own request, so a later step
 * of that kind which policy finds in their words isn't its repeat ("Share report" on a hostile page, then the user's
 * own "Post comment": evalfix-x9-1). offTaskLookup says which later steps still are.
 */
export function offTaskNames(s: RiskAsked): string[] {
  return riskNames(s).map(n => `${RISK_OFF_TASK}${n.slice(RISK.length)}`);
}
/**
 * The off-task names a later risky step is looked up under, with its own: one that is off-task itself, or whose kinds
 * come only from policy's reason (a shortcut, Enter, a line break: nothing in it is the user's words). So after a no
 * to a page's Send, its "Send later" and Ctrl+Enter stay refused (modes-x9s-3).
 */
export function offTaskLookup(s: RiskAsked, offTask: boolean): string[] {
  return offTask || riskKinds(s).said.length === 0 ? offTaskNames(s) : [];
}
/**
 * The name a refused risky step of no kind leaves behind in its app, and that a later risky step there which names no
 * kind itself (none at all, or only by policy's reason) is looked up under: it may be the refused thing done another
 * way ("Add comment", then Ctrl+Enter in the comment field; "Publish", then "Run"), which Ember can't tell. Such a
 * step is never checked or announced: it asks, and in Autopilot, which has no question to put, it is refused
 * (evalfix-x9-3).
 */
export const noKindName = (app: string | undefined): string => inApp("risk-none\n", "", app);

/** A command's class of danger as the kinds of risky step that do the same in an app, and the other way round (modes-y9-2). */
const CLASS_KINDS: Readonly<Partial<Record<DangerClass, readonly string[]>>> = { destroy: ["delete", "overwrite"], "remote-delete": ["delete"], publish: ["send"] };
const ACROSS_TO_STEP = "command-did\n", ACROSS_TO_COMMAND = "step-did\n";
/** The words of a step, or the last part of a path, as they are compared across: lower case, whole. */
const tokens = (words: string): string[] => [...new Set(words.toLowerCase().split(/[^\p{L}\p{N}._-]+/u).map(t => t.replace(/^[._-]+|[._-]+$/g, "")).filter(t => t.length >= 3))].slice(0, 60);
/** What a command's act is called in a few words: the last part of its path, or its branch, package or host. */
const thingOf = (a: CommandAct): string | null => (a.path ? a.path[a.path.length - 1]?.toLowerCase() ?? null : a.kind === "rule" || a.kind === "program" ? null : a.text.toLowerCase());

/**
 * The names a refused risky step leaves for commands: its kinds, and each with every word of the step (its control,
 * what policy read of it, its window's title), so `rm ~/report.pdf` after a no to "Delete report.pdf?" is the same
 * thing, and any other deletion by command is one Ember can't tell from it.
 */
export function stepMarksForCommands(kinds: readonly string[], words: string): string[] {
  return kinds.flatMap(k => [`${ACROSS_TO_COMMAND}${k}`, ...tokens(words).map(t => `${ACROSS_TO_COMMAND}${k}\n${t}`)]);
}
/**
 * How a risky app step of `kinds`, with `words`, stands with the commands refused in the task, by the names
 * Refusals.noteCommand left: "same" where a refused command did that kind of thing to something the step's words
 * name (the Delete key on "build" in Files after a no to `rm -rf build`), "like" where one did that kind of thing and
 * the step doesn't say to what.
 */
export function stepAcrossNames(kinds: readonly string[], words: string): { same: string[]; like: string[] } {
  return { same: kinds.flatMap(k => tokens(words).map(t => `${ACROSS_TO_STEP}${k}\n${t}`)), like: kinds.map(k => `${ACROSS_TO_STEP}${k}`) };
}

/** One thing a dangerous command does, and to what: the class, and the path, branch, package… or else the rule. */
export interface CommandAct {
  cls: DangerClass;
  kind: string;
  /** As written (for a path that could be resolved: its resolved form). */
  text: string;
  /** A resolved path's parts, up to its first wildcard: what lies in it, or holds it, is acted on too. */
  path?: string[];
  /** For a branch or a tag: the remote it goes to, where the command names one. */
  to?: string;
}

/** One finding of a command, with the words of the command it is about: how a later command may name a refused thing. */
export interface CommandNamed {
  cls: DangerClass;
  rule: string;
  /** The finding names nothing it acts on (`gh api -X PUT …`, `npm publish`): its words are all there is. */
  bare: boolean;
  /** Ember can't tell what it does (the classifier's "unclear" and "unknown"): it may be any class of danger. */
  opaque: boolean;
  /** Every word of that command, and the words inside each (inline code's quoted paths, the parts of an API path). */
  words: string[];
}

/** A command as its card was about it. */
export interface CommandAsked {
  /** commandSha256(): the bytes, shell, folder and computer an approval binds to. */
  sha256: string;
  cwd: string;
  command: string;
  acts: CommandAct[];
  /** Its findings with their commands' words (commandNamed); absent: only its acts are compared. */
  named?: CommandNamed[];
  /** The target's OS and home folder, to read a word of the command as a path. */
  os?: OS;
  home?: string;
}

const WILDCARD = /[*?[\]{}]/;
/** A branch or a tag as a command may write it: `+main`, `HEAD:main`, `refs/heads/main`. */
const ref = (text: string) => text.trim().replace(/^\+/, "").replace(/^.*:(?=[^:]+$)/, "").replace(/^refs\/(heads|tags)\//, "");
/**
 * A branch written as where the checkout stands or as a revision (`HEAD`, `@`, `HEAD~0`, `main@{0}`, `main^0`), not
 * by a name Ember can compare: such a push names no branch, so it is a push to that remote, as a bare
 * `git push origin` is, and a no to a push of main there covers it (modes-y9-x9-1).
 */
const unnamedRef = (text: string) => { const r = ref(text); return r === "" || r === "@" || /^(FETCH_|ORIG_|MERGE_)?HEAD$/i.test(r) || /[~^]|@\{/.test(r); };
const pathParts = (resolved: string, os: OS) => resolved.split(os === "win32" ? /[\\/]+/ : /\/+/).filter(p => p && p !== ".");

/**
 * What a command's findings act on (`findings`: those that stand, as the decision reads them). A finding with objects
 * gives one act for each; where no finding names an object, each gives its rule (`shutdown`, `git clean`), so a
 * wrapper's bare finding (sudo's) beside one that names something doesn't make every such command the same. A push
 * acts on its branch (to its remote): the remote's name alone is an act only where no branch is named, so a no to
 * `git push origin main` is no word on `git push origin feature`; a push of `HEAD` or `@` names none (unnamedRef). A program Ember doesn't know acts as that program
 * with those words, never as "an unknown program" (a no to one refused every other), and what Ember can't tell has no
 * act at all: likeCommand holds it instead (modes-y9-8).
 */
export function commandActs(findings: readonly Finding[], os: OS): CommandAct[] {
  const fold = (s: string) => (os === "linux" ? s : s.toLowerCase());
  const acts: CommandAct[] = [];
  const named = findings.some(f => f.objects.some(o => o.text.trim() !== ""));
  for (const f of findings) {
    if (f.cls === "unclear") continue;
    if (f.cls === "unknown") { acts.push({ cls: f.cls, kind: "program", text: fold(f.program.trim()) }); continue; }
    if (!named) { acts.push({ cls: f.cls, kind: "rule", text: f.rule }); continue; }
    const to = f.objects.find(o => o.kind === "remote")?.text.trim();
    const isRef = (o: Finding["objects"][number]) => (o.kind === "branch" || o.kind === "tag") && !unnamedRef(o.text);
    const refs = f.objects.some(isRef);
    const before = acts.length;
    for (const o of f.objects) {
      if (o.text.trim() === "") continue;
      if ((o.kind === "path" || o.kind === "glob") && o.resolved !== undefined) {
        const parts = pathParts(fold(o.resolved), os);
        const cut = parts.findIndex(p => WILDCARD.test(p));
        acts.push({ cls: f.cls, kind: "path", text: fold(o.resolved), path: o.kind === "glob" && cut >= 0 ? parts.slice(0, cut) : parts });
      } else if (o.kind === "branch" || o.kind === "tag") {
        if (isRef(o)) acts.push({ cls: f.cls, kind: o.kind, text: ref(o.text), ...(to ? { to } : {}) });
      } else if (!(o.kind === "remote" && refs)) {
        acts.push({ cls: f.cls, kind: o.kind, text: o.text.trim() });
      }
    }
    // Nothing but an unnamed branch, and no remote: the finding's rule, as where it names nothing.
    if (acts.length === before && f.objects.some(o => (o.kind === "branch" || o.kind === "tag") && o.text.trim() !== "")) acts.push({ cls: f.cls, kind: "rule", text: f.rule });
  }
  return acts;
}

/**
 * A command's findings with the words of the commands they are about (`commands`: the classification's, by
 * Finding.at), for sameCommand and likeCommand. A word is kept whole and in its parts: what stands between quotes,
 * brackets and commas inside it, so inline code's `rmtree("build")` names build.
 */
export function commandNamed(findings: readonly Finding[], commands: readonly { args: readonly (string | null)[] }[]): CommandNamed[] {
  return findings.map(f => {
    const args = (commands[f.at]?.args ?? []).filter((a): a is string => a !== null);
    const words = [...new Set(args.flatMap(a => [a, ...a.split(/[\s"'`(),;=<>|&[\]{}]+/)]).filter(Boolean))].slice(0, 200);
    return { cls: f.cls, rule: f.rule, bare: !f.objects.some(o => o.text.trim() !== ""), opaque: f.cls === "unclear" || f.cls === "unknown", words };
  });
}

/** Is one path the other, inside it, or around it? */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameAct(a: CommandAct, b: CommandAct): boolean {
  if (a.cls !== b.cls) return false;
  if (a.path && b.path) return overlaps(a.path, b.path);
  // A push of whatever is current to a remote, and a push of a named branch to that remote.
  if (a.kind === "remote" && b.to !== undefined) return a.text === b.to;
  if (b.kind === "remote" && a.to !== undefined) return b.text === a.to;
  if (a.kind !== b.kind || a.text !== b.text) return false;
  return a.to === undefined || b.to === undefined || a.to === b.to;
}

/** A word of a command read as a path on its target: where it would point from the command's folder. */
function wordPath(word: string, c: Pick<CommandAsked, "cwd" | "os" | "home">): string[] | null {
  const os = c.os ?? "linux";
  let w = os === "linux" ? word : word.toLowerCase();
  const cwd = os === "linux" ? c.cwd : c.cwd.toLowerCase();
  if (w === "" || w.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null;
  if (c.home && (w === "~" || /^~[\\/]/.test(w))) w = `${os === "linux" ? c.home : c.home.toLowerCase()}${w.slice(1)}`;
  const absolute = os === "win32" ? /^([a-z]:[\\/]|\\\\)/.test(w) : w.startsWith("/");
  const out: string[] = [];
  for (const part of pathParts(absolute ? w : `${cwd}/${w}`, os)) {
    if (WILDCARD.test(part)) break; // up to its first wildcard, as a glob's act is
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

/** Does this finding's command name what `a` acted on, however it writes it: a path at or inside it, the branch in a refspec or an API path, the package or host itself? */
function namesAct(n: CommandNamed, a: CommandAct, now: CommandAsked): boolean {
  if (a.kind === "rule" || a.kind === "program") return false;
  if (a.path) {
    const at = a.path;
    return at.length > 0 && n.words.some(w => { const p = wordPath(w, now); return p !== null && p.length >= at.length && overlaps(at, p); });
  }
  if (a.kind === "branch" || a.kind === "tag") return n.words.some(w => ref(w) === a.text || new RegExp(`(^|/)(heads|branches|tags|refs)/${a.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(w));
  return n.words.includes(a.text);
}

/** What inline code or a program Ember doesn't know says it does, in its own words: delete, or send. */
const SAYS_DELETE = /(^|[^a-z])(rm|rmdir|rmtree|unlink|remove|delete|del|erase|truncate|shred|wipe|purge|destroy|trash|drop|clean)/i;
const SAYS_SEND = /(^|[^a-z])(push|publish|upload|send|post|put|deploy|release|submit)/i;
const evident = (n: CommandNamed, cls: DangerClass): boolean =>
  (cls === "destroy" || cls === "remote-delete" ? SAYS_DELETE : cls === "publish" ? SAYS_SEND : null)?.test(n.words.join(" ")) ?? false;
/** Rules whose command takes away what it is given, though its finding names where it goes: a move's source. */
const MOVES_ITS_SOURCE = /(^|\.)(mv|move|Move-Item|robocopy)$/i;

/**
 * Is `now` the command the user turned down (`before`), sent again or reworded? The same bytes (in any shell, from the
 * same folder), or the same kind of danger to the same thing: `find build -delete` after a refused `rm -rf build`, a
 * deletion inside the folder or of the folder around it. And the same thing however the later command names it
 * (modes-y9-9): a finding of that class that names nothing itself, or a move, whose command's words name the refused
 * thing (`mv build /tmp/x`; `gh api -X PUT repos/o/r/git/refs/heads/main` after a refused force push of main), and
 * code Ember can't read that names it and says what it does to it (`shutil.rmtree("build")`). A different danger, or
 * the same one to something else, isn't.
 */
export function sameCommand(before: CommandAsked, now: CommandAsked): boolean {
  if (before.sha256 === now.sha256) return true;
  if (before.cwd === now.cwd && before.command.trim() === now.command.trim()) return true;
  if (before.acts.some(a => now.acts.some(b => sameAct(a, b)))) return true;
  return (now.named ?? []).some(n => before.acts.some(a =>
    (n.opaque ? evident(n, a.cls) : n.cls === a.cls && (n.bare || MOVES_ITS_SOURCE.test(n.rule))) && namesAct(n, a, now)));
}

/**
 * May `now` be the command the user turned down, though Ember can't tell? Where it has a finding that names nothing
 * it acts on, of a class the refused command had (`npm publish` after a refused push; `gh api -X PUT …` that names
 * no refused branch), or one Ember can't read at all (a loop, inline code, a program it doesn't know: it may be any
 * class). Such a command is never announced or shown to Assisted's check: it asks, in every mode, which is the
 * user's to answer (modes-y9-9). It refuses nothing.
 */
export function likeCommand(before: CommandAsked, now: CommandAsked): boolean {
  if (before.acts.length === 0) return false;
  return (now.named ?? []).some(n => n.opaque || (n.bare && before.acts.some(a => a.cls === n.cls)));
}

/** One task's refusals. */
export class Refusals {
  private steps = new Map<string, Standing>();
  private commands: { asked: CommandAsked; standing: Standing }[] = [];
  /** The user turned down turning commands on for this task's computer (the first-use card): asked once, as any step. */
  private consent: Standing | null = null;

  /** A question about an app step ended without a yes. A no is never weakened to "waiting" by a later timeout. */
  noteStep(names: readonly string[], standing: Standing): void {
    for (const n of names) if (this.steps.get(n) !== "refused") this.steps.set(n, standing);
  }

  /** How an app step stands: refused under any of its names, else waiting under any, else null (never asked, or allowed). */
  step(names: readonly string[]): Standing | null {
    const found = names.map(n => this.steps.get(n));
    return found.includes("refused") ? "refused" : found.includes("waiting") ? "waiting" : null;
  }

  /**
   * A command's card ended without a yes, or the user stopped its countdown. A no also leaves, for app steps, what the
   * command would have done and to what (stepAcrossNames reads them): deleting `build` in Files is that deletion done
   * another way (modes-y9-2).
   */
  noteCommand(asked: CommandAsked, standing: Standing): void {
    this.commands.push({ asked, standing });
    if (standing !== "refused") return;
    for (const a of asked.acts) {
      const thing = thingOf(a);
      for (const k of CLASS_KINDS[a.cls] ?? []) this.noteStep([`${ACROSS_TO_STEP}${k}`, ...(thing && thing.length >= 2 ? [`${ACROSS_TO_STEP}${k}\n${thing}`] : [])], "refused");
    }
  }

  /**
   * How a command stands: refused if it is one the user said no to (sameCommand), or does to something what a risky
   * app step they said no to did, where that step's words named it (stepMarksForCommands); else waiting, else null.
   */
  command(now: CommandAsked): Standing | null {
    const found = this.commands.filter(c => sameCommand(c.asked, now)).map(c => c.standing);
    if (found.includes("refused")) return "refused";
    const across = now.acts.some(a => { const thing = thingOf(a); return !!thing && (CLASS_KINDS[a.cls] ?? []).some(k => this.steps.get(`${ACROSS_TO_COMMAND}${k}\n${thing}`) === "refused"); });
    return across ? "refused" : found.includes("waiting") ? "waiting" : null;
  }

  /**
   * May this command be something the user said no to in this task, though Ember can't tell (likeCommand; and after a
   * no to a risky app step, a command of that step's kind, or one Ember can't read)? It asks then, whatever the mode.
   */
  commandLike(now: CommandAsked): boolean {
    if (this.commands.some(c => c.standing === "refused" && likeCommand(c.asked, now))) return true;
    const kinds = [...new Set([...now.acts.map(a => a.cls), ...(now.named ?? []).map(n => n.cls)].flatMap(c => CLASS_KINDS[c] ?? []))];
    if (kinds.some(k => this.steps.get(`${ACROSS_TO_COMMAND}${k}`) === "refused")) return true;
    return (now.named ?? []).some(n => n.opaque) && [...this.steps].some(([n, st]) => st === "refused" && n.startsWith(ACROSS_TO_COMMAND));
  }

  /** The first-use commands card ended without a yes. */
  noteConsent(standing: Standing): void {
    if (this.consent !== "refused") this.consent = standing;
  }

  /** How turning commands on stands for this task. */
  get commandsConsent(): Standing | null {
    return this.consent;
  }

  /**
   * The user said something to the task: a question nobody answered may be asked again (they are there now). What they
   * said no to stays refused: asking for it afresh is a new request, which is a new task.
   */
  userSpoke(): void {
    for (const [n, s] of this.steps) if (s === "waiting") this.steps.delete(n);
    this.commands = this.commands.filter(c => c.standing === "refused");
    if (this.consent === "waiting") this.consent = null;
  }
}
