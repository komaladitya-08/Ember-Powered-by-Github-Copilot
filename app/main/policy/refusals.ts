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
  keys: "keys", scroll: "scroll", setting: "setting", open_app: "open",
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
 * (normalizeLabel), from the start of a word; "pay" and "quit" as whole words, which other languages' words begin with
 * (Spanish "quitar" removes, Turkish "paylaş" shares).
 */
const DOES: readonly (readonly [string, RegExp])[] = [
  ["send", /\b(send|sent|post|submit|publish|share|reply|forward|upload|tweet|invite)/],
  ["delete", /\b(delete|remove|trash|erase|discard|wipe|destroy|format|uninstall|purge|unsubscribe|don't save|without saving|wastebasket|rubbish bin|recycle bin|move to (the )?bin)/],
  ["pay", /\b(pay(s|ing|ments?)?\b|paid|buy|purchase|order|checkout|check out|donate|transfer|subscribe|billing)/],
  ["install", /\b(install|update|upgrade|download)/],
  ["sign-out", /\b(sign ?out|log ?out|sign off|log off|disconnect)/],
  ["overwrite", /\b(overwrite|replace)/],
  ["reset", /\b(revert|reset|restore)/],
  ["close", /\b(close|quit(s|ting)?\b|exit)/],
  ["leave", /\bleave/],
  ["block", /\b(block|ban\b|banned|banning)/],
  ["security", /\b(security|protection|firewall|password|permission|privacy|unsafe)/],
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
  fr: { send: "envoy|envoie|soumett|répond|transfér|partag|publi|télévers|invit|tweet", delete: "supprim|suppression|effac|retir|enlev|corbeille|désinstall|se désabonn|ne pas enregistrer|sans enregistrer",
    pay: "command|achet|pay|s'abonn", install: "install", "sign-out": "déconn", overwrite: "remplac|écras", reset: "réinitialis", close: "quitter|fermer", block: "bloquer|bannir" },
  de: { send: "send|absend|versend|abschick|verschick|einreich|übermitt|antwort|weiterleit|teilen|freigeb|veröffentlich|hochlad|einlad|twitter|tweet",
    delete: "lösch|loesch|entfern|in den papierkorb|verwerf|deinstallier|abbestell|nicht speichern|ohne speichern|ohne zu speichern",
    pay: "kauf|bestell|zahlungspflichtig|bezahl|jetzt zahlen|überweis|abonnier", install: "installier", "sign-out": "abmeld|auslogg", overwrite: "ersetz|überschreib", reset: "zurücksetz",
    close: "beenden|konto schließen", block: "blockier|bannen|verbann" },
  es: { send: "envi|respond|reenv|compart|public|publique|subir|invit|tuit", delete: "elimin|borr|suprim|quit|papelera|descart|desinstal|darse de baja|no guardar|sin guardar",
    pay: "compr|pedido|pag|transf|suscribirse", install: "instal", "sign-out": "cerrar sesión|desconect", overwrite: "reemplaz|reemplac|sustitu|sobrescrib|sobreescrib", reset: "restablec|revertir",
    close: "salir|cerrar \\(", block: "bloquear|banear" },
  it: { send: "invia|spedi|rispond|inoltr|condivid|pubblic|carica file|invita|twitt", delete: "elimin|cancell|rimuov|cestin|scart|disinstall|non salvare|senza salvare",
    pay: "acquist|comprare|ordina ora|effettua|pag|bonifico|iscriviti", install: "install", "sign-out": "disconnetti|esci", overwrite: "sostitu|sovrascriv", reset: "reimpost|ripristina",
    close: "chiudi", block: "blocca|banna" },
  pt: { send: "envie|responda|encaminh|compartilh|partilh|convid|tuit", delete: "exclu|apag|deletar|remov|lixeira|não salvar|não guardar|sem salvar|sem guardar",
    pay: "compr|pedido|pague|transfira|inscrever-se", "sign-out": "sessão", overwrite: "substitu|sobrescrev", reset: "redefin|reverter|restaurar", close: "sair|\\(encerrar\\|fechar\\)", block: "bloquear|banir" },
  nl: { send: "verzend|verstu|indien|beantwoord|antwoorden|doorstur|delen|publice|uitnodig|nodig uit|tweet", delete: "verwijder|prullenbak|verwerp|de-installer|niet opslaan|zonder opslaan",
    pay: "kopen|koop|bestel|afreken|betal|betaal|overmak|overboek", install: "installe", "sign-out": "afmeld|uitlogg", overwrite: "vervang|overschrijv", reset: "resetten|opnieuw instellen|terugdraai",
    close: "afsluiten|account \\(sluiten", block: "blokker|verbann" },
  pl: { send: "wyślij|wysłać|odpowiedz|przekaż|udostępnij|opublikuj|zaproś|tweetuj", delete: "usuń|usunąć|skasuj|odrzuć|do kosza|odinstaluj|nie zapisuj|bez zapisywania",
    pay: "kup|zamów|zamawiam|zapłać|płacę|przelew", install: "zainstaluj", "sign-out": "wyloguj", overwrite: "zastąp|nadpis", reset: "resetuj|zresetuj", close: "zamknij konto", block: "zablokuj|zbanuj" },
  ru: { send: "отправ|послать|ответ|переслать|перешли|подели|опублик|приглас|твитнуть", delete: "удал|убрать|в корзину|не сохранять|без сохранения|отписаться",
    pay: "купи|оформить заказ|заказать|закажи|оплат|заплатить", install: "установ", "sign-out": "выйти|выход", overwrite: "замен|перезаписать", reset: "сброс|откатить", close: "закрыть аккаунт",
    block: "заблокир|забанить" },
  sv: { send: "skicka|svara|vidarebefordra|publicera|bjud in|tweeta", delete: "ta bort|radera|töm papperskorgen|till papperskorgen|avinstallera|spara inte|utan att spara",
    pay: "köp|beställ|betala", install: "installera", "sign-out": "logga ut", overwrite: "ersätt|skriv över", reset: "återställ", close: "\\(avsluta\\|stäng", block: "blockera|bannlys" },
  da: { send: "svar|videresend|inviter|invitér", delete: "slet|fjern|i papirkurven|afinstaller|gem ikke|uden at gemme", pay: "køb|bestil|betal", install: "installer", "sign-out": "log ud",
    overwrite: "erstat|overskriv", reset: "nulstil", close: "\\(luk", block: "bloker|udeluk" },
  nb: { send: "inviter", delete: "slett|i papirkurven|avinstaller|ikke lagre|uten å lagre", pay: "kjøp|bestill", "sign-out": "logg ut", overwrite: "erstatt|overskriv", reset: "tilbakestill",
    close: "\\(avslutt\\|lukk", block: "blokker|utesteng" },
  fi: { send: "lähetä|vastaa|välitä|jaa|julkaise|kutsu|twiittaa", delete: "poista|roskakoriin|älä tallenna|tallentamatta", pay: "osta|tilaa nyt|maksa", install: "asenna", "sign-out": "kirjaudu ulos",
    overwrite: "korvaa", reset: "nollaa", close: "sulje tili", block: "estä" },
  cs: { send: "odeslat|odešli|odpovědět|přeposlat|sdílet|publikovat|zveřejnit|pozvat|tweetnout", delete: "smazat|smaž|odstranit|odstraň|do koše|odinstalovat|neukládat|bez uložení",
    pay: "koupit|objednat|zaplatit", install: "nainstalovat|instalovat", "sign-out": "odhlásit", overwrite: "nahradit|přepsat", reset: "resetovat|vrátit změny", close: "zavřít účet",
    block: "zablokovat|blokovat|zabanovat" },
  tr: { send: "gönder|yanıtla|cevapla|ilet|paylaş|yayınla|davet et|tweetle", delete: "sil|kaldır|çöpe taşı|kaydetme", pay: "satın al|sipariş ver|ödeme|havale", install: "yükle",
    "sign-out": "çıkış yap|oturumu kapat", overwrite: "üzerine yaz", reset: "sıfırla", close: "\\(hesabı\\|hesabımı\\) kapat", block: "engelle|yasakla" },
};
/** Scripts without spaces between words: policy's own entries (RISKY_ANYWHERE, RISKY_ACT_ANYWHERE) of each kind, matched anywhere. */
const ANYWHERE: Readonly<Record<string, readonly string[]>> = {
  send: ["送信", "返信", "転送", "共有", "公開", "投稿", "招待", "ツイート", "发送", "發送", "提交", "回复", "回覆", "转发", "轉發", "分享", "共享", "发布", "發佈", "發布", "发表", "發表",
    "邀请", "邀請", "전송", "보내기", "제출", "답장", "전달", "공유", "게시", "초대", "트윗"],
  delete: ["削除", "消去", "破棄", "保存しない", "保存せず", "ゴミ箱", "删除", "刪除", "移除", "放弃", "放棄", "不保存", "回收站", "废纸篓", "廢紙簍", "卸载", "卸載", "삭제", "제거", "저장 안 함",
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
}
/**
 * The names a risky step goes by besides its own (stepNames): one for each thing it does. By the words policy found
 * it risky for: the control's own name where that names a kind (a dialog's "Discard" discards, whatever the dialog
 * goes on to say), else all of them (a "Yes" is what its dialog asks, a choice what was chosen); never a name policy
 * found nothing risky in (the field a shortcut is pressed in). And by policy's reason where that says what the step
 * may do (REASON_DOES). A step whose words name no kind has none: it is known by its own names alone, and is no other
 * step's repeat (evalfix-1: a no to the page's "Delete all" refused the user's own "Add comment", which counted as
 * every kind).
 */
export function riskNames(s: RiskAsked): string[] {
  const own = s.name.trim() && s.about.startsWith(s.name) ? kindsOf(s.name) : [];
  const said = !s.about.trim() ? [] : own.length ? own : kindsOf(s.about);
  const why = REASON_DOES.filter(([re]) => re.test(s.reason)).flatMap(([, kinds]) => kinds);
  return [...new Set([...said, ...why])].map(k => `${RISK}${k}`);
}

/** One thing a dangerous command does, and to what: the class, and the path, branch, package… or else the rule. */
export interface CommandAct {
  cls: DangerClass;
  kind: string;
  /** As written (for a path that could be resolved: its resolved form). */
  text: string;
  /** A resolved path's parts, up to its first wildcard: what lies in it, or holds it, is acted on too. */
  path?: string[];
}

/** A command as its card was about it. */
export interface CommandAsked {
  /** commandSha256(): the bytes, shell, folder and computer an approval binds to. */
  sha256: string;
  cwd: string;
  command: string;
  acts: CommandAct[];
}

const WILDCARD = /[*?[\]{}]/;

/**
 * What a command's findings act on (`findings`: those that stand, as the decision reads them). A finding with objects
 * gives one act for each; where no finding names an object, each gives its rule (`shutdown`, `git clean`), so a
 * wrapper's bare finding (sudo's) beside one that names something doesn't make every such command the same.
 */
export function commandActs(findings: readonly Finding[], os: OS): CommandAct[] {
  const fold = (s: string) => (os === "linux" ? s : s.toLowerCase());
  const acts: CommandAct[] = [];
  const named = findings.some(f => f.objects.length > 0);
  for (const f of findings) {
    if (!named) { acts.push({ cls: f.cls, kind: "rule", text: f.rule }); continue; }
    for (const o of f.objects) {
      if ((o.kind === "path" || o.kind === "glob") && o.resolved !== undefined) {
        const parts = fold(o.resolved).split(os === "win32" ? /[\\/]+/ : /\/+/).filter(p => p && p !== ".");
        const cut = parts.findIndex(p => WILDCARD.test(p));
        acts.push({ cls: f.cls, kind: "path", text: fold(o.resolved), path: o.kind === "glob" && cut >= 0 ? parts.slice(0, cut) : parts });
      } else {
        acts.push({ cls: f.cls, kind: o.kind, text: o.text.trim() });
      }
    }
  }
  return acts;
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
  return a.kind === b.kind && a.text === b.text;
}

/**
 * Is `now` the command the user turned down (`before`), sent again or reworded? The same bytes (in any shell, from the
 * same folder), or the same kind of danger to the same thing: `find build -delete` after a refused `rm -rf build`, a
 * deletion inside the folder or of the folder around it. A different danger, or the same one to something else, isn't.
 */
export function sameCommand(before: CommandAsked, now: CommandAsked): boolean {
  if (before.sha256 === now.sha256) return true;
  if (before.cwd === now.cwd && before.command.trim() === now.command.trim()) return true;
  return before.acts.some(a => now.acts.some(b => sameAct(a, b)));
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

  /** A command's card ended without a yes, or the user stopped its countdown. */
  noteCommand(asked: CommandAsked, standing: Standing): void {
    this.commands.push({ asked, standing });
  }

  /** How a command stands: refused if it is one the user said no to (sameCommand), else waiting, else null. */
  command(now: CommandAsked): Standing | null {
    const found = this.commands.filter(c => sameCommand(c.asked, now)).map(c => c.standing);
    return found.includes("refused") ? "refused" : found.includes("waiting") ? "waiting" : null;
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
