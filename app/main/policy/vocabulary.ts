/**
 * The words the policy, the worker and the host match against, per OS: which windows are security prompts, which
 * apps are browsers, mail and office suites, which extra labels are risky, which boxes run what is typed into them,
 * which windows Ember only reads, which apps run the programs they open, how the user names the terminal, and what
 * names a file. Pure data, keyed by OS, read through policy.ts and the agent (one copy for every reader). The Linux rows
 * are the expressions those files held before the port, moved verbatim, and must not change (tests pin them).
 *
 * The Windows and macOS rows (design §9.11) match what those systems report as a window's app: on Windows its
 * program's file name ("CredentialUIBroker", with or without ".exe"), on macOS the app's name in the user's language
 * ("Keychain Access", "Schlüsselbundverwaltung") or its bundle id. App lists match whole words (split at spaces, ".",
 * "-", "_" and "!"), never parts of words, so "olk" (the new Outlook) doesn't match "Folkets". Security prompts are
 * whole names and whole titles: a security match makes Ember look away and stay out, so these lists hold no word that
 * also names ordinary windows. CI checks the names on real windows (test/integration/win32-vocabulary.test.ts and
 * darwin-vocabulary.test.ts).
 */

import type { OS } from "../../shared/shortcuts";
import { TERMINALS } from "../hands/terminals";

/** `s` as a literal in a regular expression. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A literal that matches whichever Unicode form the system hands over: macOS can give an accented name decomposed
 * ("e" and a combining accent) or composed, and an app's name is tested as it comes.
 */
const anyForm = (s: string) => [...s.normalize("NFC")].map(c => (c.normalize("NFD") === c ? literal(c) : `(?:${literal(c)}|${literal(c.normalize("NFD"))})`)).join("");

/** Exactly one of `names` (then `suffix`), any case: an app as a whole, never a word of it. */
const exactly = (names: readonly string[], suffix = "") => new RegExp(`^(?:${names.map(anyForm).join("|")})${suffix}$`, "iu");

/** One of `names` (regular-expression source) as whole words of an app's name or id, any case. */
const appWords = (names: readonly string[]) => new RegExp(`(?:^|[\\s._!-])(?:${names.join("|")})(?=$|[\\s._!-])`, "iu");

/**
 * Programs that only ask for passwords, and the firewall's settings, tested on the window's app (trimmed). Linux:
 * polkit agents, the keyring's and GnuPG's prompts, and GNOME Shell, which draws its own password prompts in its own
 * window (Ember never acts in the shell anyway). Windows: the credential, consent, sign-in, lock-screen, Windows Hello,
 * BitLocker and SmartScreen programs and the Windows Security app. macOS: the authorisation, Touch ID, privacy (TCC)
 * and Gatekeeper agents, the login window and screen saver, Keychain Access and the Passwords app (those two also by
 * their names in other languages, and by bundle id).
 */
export const SECURITY_APP: Readonly<Record<OS, RegExp | null>> = {
  linux: /polkit|gcr-prompter|pinentry|ssh-askpass|ksshaskpass|^firewall-config$|(^|\s)gnome-shell(\s|$)/i,
  win32: exactly([
    "credentialuibroker", "consent", "logonui", "lockapp", "credwiz", "sechealthui", "securityhealthhost", "securityhealthsystray", "smartscreen",
    "bdeunlock", "bdeuisrv", "microsoft.aad.brokerplugin", "wwahost", "pinenrollmentbroker", "bioenrollmenthost", "credentialenrollmentmanager",
    // UAC's own settings (the slider that turns the consent prompt off), as Linux's firewall-config.
    "useraccountcontrolsettings",
  ], String.raw`(?:\.exe)?`),
  darwin: exactly([
    "securityagent", "com.apple.securityagent", "coreautha", "coreauthd", "loginwindow", "com.apple.loginwindow", "screensaverengine",
    "com.apple.screensaver.engine", "coreservicesuiagent", "com.apple.coreservices.uiagent", "universalaccessauthwarn", "usernotificationcenter",
    "com.apple.usernotificationcenter", "authenticationservicesagent", "ticket viewer", "certificate assistant",
    "keychain access", "com.apple.keychainaccess", "schlüsselbundverwaltung", "trousseaux d'accès", "trousseaux d’accès", "acceso a llaveros",
    "accesso portachiavi", "acesso às chaves", "sleutelhangertoegang", "キーチェーンアクセス", "钥匙串访问", "鑰匙圈存取", "키체인 접근",
    // The Passwords app (macOS 15), only as the whole name: "passwords" is an ordinary word in titles.
    "passwords", "com.apple.passwords", "passwörter", "mots de passe", "contraseñas", "senhas", "wachtwoorden", "パスワード", "密码", "密碼", "암호",
  ]),
};

/**
 * Titles of authentication prompts, by how such a title starts (tested on the normalised title): never words that
 * turn up in ordinary titles too ("firewall-notes.txt", a page about sudo), so those windows are read and used as
 * usual. Windows and macOS match whole titles. Windows: its prompts, and the security pages of Settings and Control
 * Panel. macOS: System Settings' Privacy & Security pane (also in other languages), the privacy pages inside it where
 * apps are granted Accessibility, Screen Recording, Input Monitoring and the like (the page's name is the window's
 * title there: Ember must never switch itself on), and SecurityAgent's "… wants to make changes" read as a title.
 */
export const SECURITY_TITLE: Readonly<Record<OS, RegExp | null>> = {
  linux: /^\s*(authenticat(e|ion)\b.*\b(required|request)\b|authenticate\s*$|(password|passphrase|pin) (required|request(ed)?)\b|enter (the |your |a )?(password|passphrase|pin)\b|unlock\b.*\b(keyring|private key|password|passphrase)\b|\[sudo\]|sudo password\b)/,
  win32: new RegExp(String.raw`^\s*(windows\s+security|user\s+account\s+control(\s+settings)?|enter\s+network\s+credentials|windows\s+hello|making\s+sure\s+it's\s+you`
    + String.raw`|credential\s+manager|stored\s+user\s+names\s+and\s+passwords|bitlocker\s+drive\s+encryption`
    + String.raw`|windows\s+defender\s+firewall(\s+with\s+advanced\s+security)?)\s*$`),
  darwin: new RegExp(String.raw`^\s*(privacy\s+&\s+security|passwords|touch\s+id\s+&\s+password|users\s+&\s+groups|login\s+password`
    + String.raw`|accessibility|screen\s+recording|screen\s+&\s+system\s+audio\s+recording|input\s+monitoring|full\s+disk\s+access|automation`
    + String.raw`|developer\s+tools|app\s+management`
    + String.raw`|datenschutz\s+&\s+sicherheit|confidentialité\s+et\s+sécurité|privacidad\s+y\s+seguridad|privacy\s+e\s+sicurezza`
    + String.raw`|privacidade\s+e\s+segurança|privacy\s+en\s+beveiliging|プライバシーとセキュリティ|隐私与安全性|隱私權與安全性|개인정보\s+보호\s+및\s+보안)\s*$`
    + String.raw`|^.*\bwants\s+to\s+(use\s+your\s+confidential\s+information|make\s+changes)`, "u"),
};

/**
 * The system's own Settings apps, tested on the window's app (trimmed): their switches weaken protection or grant
 * devices to apps (the screen lock, location, camera, microphone, developer mode, remote assistance, login items) with
 * labels that say nothing of security, and a macOS privacy pane names only the app it grants something to ("Terminal"),
 * so policy.ts asks about every setting changed in them. Linux: GNOME Settings. Windows: Settings and System
 * Properties' pages (remote assistance and desktop, system protection, performance, the computer's name). macOS: System
 * Settings (System Preferences before macOS 13), by its bundle id and its names in other languages.
 */
export const SETTINGS_APP: Readonly<Record<OS, RegExp | null>> = {
  linux: /^(gnome-control-center|org\.gnome\.settings)$/i,
  win32: exactly(["systemsettings", "systempropertiesremote", "systempropertiesprotection", "systempropertiesadvanced", "systempropertiesperformance",
    "systempropertiescomputername", "systempropertieshardware", "systempropertiesdataexecutionprevention"], String.raw`(?:\.exe)?`),
  darwin: exactly(["system settings", "system preferences", "com.apple.systempreferences", "com.apple.settings", "systemeinstellungen",
    "réglages système", "préférences système", "ajustes del sistema", "preferencias del sistema", "impostazioni di sistema", "preferenze di sistema",
    "ajustes do sistema", "definições do sistema", "preferências do sistema", "systeeminstellingen", "systeemvoorkeuren", "システム設定", "システム環境設定",
    "系统设置", "系统偏好设置", "系統設定", "系統偏好設定", "시스템 설정", "시스템 환경설정"]),
};

/**
 * Window classes of security prompts (lower case, whole), for the backends that report one: perception passes a
 * window's class as its app (WM_CLASS's parts on Linux, the Win32 class on Windows), so it is matched where the app
 * is. Empty on Linux, whose prompts are known by their programs, and on macOS, which has no window classes.
 */
export const SECURITY_CLASS: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  // The Windows Security credential dialog's XAML host, and the consent and credential dialogs' interim window.
  win32: ["credential dialog xaml host", "$$$secure uap dummy window class for interim dialog"],
  darwin: [],
};

/** Web browsers on Windows and macOS (programs, bundle names and the last word of their ids). */
const BROWSERS = ["chrome", "chromium", "firefox", "brave", "opera", "vivaldi", "librewolf", "waterfox", "floorp", "thorium", "arc", "seamonkey"];
/** Chat apps on every desktop OS (Slack's macOS bundle is "slackmacgap", the new Teams' "teams2"). */
const CHAT = ["slack", "slackmacgap", "teams2?", "ms-teams", "discord", "element", "mattermost", String.raw`rocket\.?chat`, "signal", "telegram", "whatsapp"];

/** Apps whose window shows one page, message or chat after another, its title saying which: there another title is another place. */
export const TABBED_APP: Readonly<Record<OS, RegExp | null>> = {
  linux: /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|thunderbird|evolution|geary|claws|mail|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram/i,
  // Edge, the browsers, Outlook (classic, the new one "olk", and the Mail app's "hxoutlook"), Thunderbird, Teams and chat.
  win32: appWords(["msedge", "iexplore", ...BROWSERS, "outlook", "olk", "hxoutlook", "thunderbird", "mail", ...CHAT]),
  // Safari, the browsers, Mail, Outlook, and Messages (also in a few languages, and as "com.apple.mobilesms").
  darwin: appWords(["safari", "orion", ...BROWSERS, "mail", "outlook", "thunderbird", "messages", "mobilesms", "nachrichten", "mensajes", "messaggi",
    "mensagens", "berichten", "メッセージ", "信息", "訊息", "메시지", ...CHAT]),
};

/** Web browsers and the apps built on a web engine (Electron), and chat apps: where Ember can't tell, a field there is a page's. */
export const WEB_APP: Readonly<Record<OS, RegExp | null>> = {
  linux: /firefox|chrom(e|ium)|epiphany|^web$|falkon|midori|opera|brave|vivaldi|konqueror|librewolf|seamonkey|electron|slack|teams|discord|element|mattermost|rocket\.?chat|signal|telegram|whatsapp/i,
  // The new Outlook ("olk") and Teams are web apps in WebView2; classic Outlook and Thunderbird are not.
  win32: appWords(["msedge", "msedgewebview2", "iexplore", ...BROWSERS, "electron", "olk", ...CHAT]),
  darwin: appWords(["safari", "orion", ...BROWSERS, "electron", "messages", "mobilesms", ...CHAT]),
};

/** Office suites: Enter in their fields and their documents' text never sends (LibreOffice on Linux). */
export const OFFICE_APP: Readonly<Record<OS, RegExp | null>> = {
  linux: /soffice|libreoffice/i,
  // Word, Excel, PowerPoint and LibreOffice (its windows' program is soffice.bin).
  win32: appWords(["winword", "excel", "powerpnt", "soffice", "libreoffice"]),
  // Microsoft's apps by name and bundle id, iWork's ("com.apple.iwork.pages"), and LibreOffice.
  darwin: appWords(["microsoft word", "microsoft excel", "microsoft powerpoint", String.raw`com\.microsoft\.(word|excel|powerpoint)`, "pages", "numbers",
    "keynote", "soffice", "libreoffice"]),
};

/**
 * Labels risky on that OS beyond policy.ts's RISKY (whole words, regular-expression source, matched on the normalised
 * label like RISKY): the system's own words for what can't be undone ("Move to Recycle Bin", "Force Quit", "End task"),
 * also in the languages of policy.ts's lists where they don't know them yet. \b sees only ASCII letters, so each entry
 * starts and ends on one (Italian "Termina attività" is matched up to its accented letter).
 */
export const RISKY_EXTRA: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  win32: [
    "move to (the )?recycle bin", "move to bin", "end task", "unblock", "open anyway", "run anyway", "force quit", "empty (the )?(recycle )?bin",
    "delete permanently", "papierkorb entleeren", "fin de t[aâ]che", "finalizar (la )?tarea", "termina attivit(?=à)", "finalizar tarefa",
  ],
  darwin: [
    "move to bin", "move to recycle bin", "end task", "unblock", "open anyway", "run anyway", "force quit", "empty bin", "delete permanently",
    "papierkorb entleeren", "placer dans la corbeille", "trasladar a la papelera", "forzar salida", "uscita forzata", "for[cç]ar encerrar",
  ],
};

/**
 * Controls that run a program or let one run, beyond policy.ts's RUNS_PROGRAM (whole words, regular-expression source,
 * matched on the folded label): "Unblock" on a file's Properties (it removes the mark of the web, so the file then
 * runs without SmartScreen's warning), SmartScreen's "Run anyway" and Gatekeeper's "Open Anyway", in English and the
 * languages of policy.ts's lists.
 */
export const RUNS_PROGRAM_EXTRA: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  win32: ["unblock", "run anyway", "open anyway", "débloquer", "desbloquear", "annulla blocco", "解除锁定", "解除封鎖", "exécuter quand même",
    "ejecutar de todas formas", "esegui comunque", "executar mesmo assim", "trotzdem ausführen", "仍要运行", "仍要執行"],
  darwin: ["open anyway", "run anyway", "trotzdem öffnen", "ouvrir quand même", "abrir igualmente", "apri comunque", "abrir mesmo assim", "toch openen",
    "このまま開く", "仍要打开", "強制打開", "그래도 열기"],
};

/**
 * Dialogs asking whether to run a file, beyond policy.ts's RUN_FILE_DIALOG (whole words, regular-expression source,
 * matched on the folded title and text): there the dialog's "Run" runs it. Windows: Explorer's "Open File - Security
 * Warning"; macOS: Gatekeeper's "… downloaded from the Internet. Are you sure you want to open it?" (its window is
 * CoreServicesUIAgent's, a security app, so Ember stays out of it anyway).
 */
export const RUN_FILE_DIALOG_EXTRA: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  win32: ["open file - security warning", "datei öffnen - sicherheitswarnung", "ouvrir le fichier - avertissement de sécurité",
    "abrir archivo - advertencia de seguridad", "apri file - avviso di protezione"],
  darwin: ["are you sure you want to open it", "downloaded from the internet"],
};

/**
 * Answers that run the file in the OS's own run dialogs (RUN_FILE_DIALOG_EXTRA), beyond policy.ts's RUN_ANSWER (a whole
 * word at the start of the label, written with its accents, folded when matched): on macOS Gatekeeper's "Open", which
 * runs the downloaded app or script it asks about, in English and the languages of RUNS_PROGRAM_EXTRA. Counted only in
 * those dialogs: anywhere else "Open" is an ordinary button (an Open panel's opens a document).
 */
export const RUN_ANSWER_EXTRA: Readonly<Record<OS, readonly string[]>> = {
  linux: [],
  win32: [],
  darwin: ["open", "öffnen", "ouvrir", "abrir", "apri", "openen", "開く", "打开", "打開", "열기"],
};

/** A box where text typed in runs a program (File Explorer's address box runs "cmd" with Enter). */
export interface TypingRefusal {
  /** The app, tested on ActionRequest.app (trimmed). */
  readonly app: RegExp;
  /** The box, tested on its accessible name (ActionRequest.element.name, trimmed). */
  readonly field: RegExp;
  /** The text refused there, tested on the text trimmed; absent: any text. */
  readonly text?: RegExp;
}

/**
 * What File Explorer's address box would start instead of opening a folder: a bare name ("cmd", "wt", "%ComSpec%"),
 * a file Windows runs or opens a script with, a terminal by its path with or without ".exe" (Explorer finds the
 * program as the Run box does), or a URI scheme other than a drive letter ("shell:AppsFolder\…" starts an app,
 * "ms-msdt:" a troubleshooter). A folder's path ("C:\Users\ada", "\\server\share", "%USERPROFILE%\Documents") goes.
 * Each of these may lead a command line too ("cmd /k …", "C:\Windows\System32\cmd.exe /k …"): the box hands what
 * follows the program to it as arguments, as the Run box does, so the first word counts, and a word's end does too.
 */
const STARTS_PROGRAM = new RegExp(String.raw`^"?[^\\/:*?"<>|\s]+"?(\s|$)`
  + String.raw`|\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msc|msi|msp|lnk|pif|scr|cpl|hta|reg|url|appref-ms|application|jar|py|pyw)"?(\s|$)`
  + String.raw`|[\\/](${[...TERMINALS.win32].map(literal).join("|")})"?(\s|$)`
  + String.raw`|^"?[a-z][\w+.-]+:`, "i");

/**
 * File Explorer's address box ("Address", or "Address: <folder>" while it shows the path), in Windows' display languages;
 * and, whatever the language, the box while it shows a folder's path ("<one or two words>: C:\…", "…: \\server\…",
 * "…: %USERPROFILE%\…", "…: shell:…"), the shape no other box of Explorer's has.
 */
const ADDRESS_BOX = new RegExp(String.raw`^(address|adresse|dirección|indirizzo|endereço|adres|アドレス|地址|位址|주소|адрес|адреса|adress|adresa|adresas|adrese|`
  + String.raw`adresă|aadress|osoite|cím|naslov|διεύθυνση|כתובת|العنوان|ที่อยู่)(\s*[:：].*)?$`
  + String.raw`|^[^\s:：\\/]+(\s[^\s:：\\/]+)?\s*[:：]\s*([a-z]:\\|\\\\|%[\w()]+%|shell:)`, "iu");
/** The Run dialog's "Open:" box, in Windows' display languages (an access key may follow: "打开(O):", "名前(O):"). */
const RUN_BOX = /^(open|öffnen|ouvrir|abrir|apri|openen|打开|開啟|열기|名前|открыть|відкрити|отваряне|otwórz|otevřít|otvoriť|otvori|odpri|aç|öppna|åbn|åpne|avaa|ava|megnyitás|άνοιγμα|פתח|פתיחה|فتح|deschidere|atvērt|atidaryti|เปิด)\s*(\(\w\))?\s*[:：]?$/iu;

/**
 * Boxes where type_text and fill_cells refuse to type a program's name. Empty on Linux: GNOME has no such box.
 * These Windows rules know the boxes and windows by their words in Windows' display languages (a Language Interface
 * Pack beyond them is judged as any other app); the accessibility host doesn't pass the controls' AutomationId or
 * class name to the policy yet, which would know them in any language.
 * Windows: File Explorer's address box, and the Run dialog's box (it belongs to explorer.exe too), where any text
 * typed runs with Enter.
 */
export const TYPING_REFUSED: Readonly<Record<OS, readonly TypingRefusal[]>> = {
  linux: [],
  win32: [
    { app: /^explorer(\.exe)?$/i, field: ADDRESS_BOX, text: STARTS_PROGRAM },
    { app: /^explorer(\.exe)?$/i, field: RUN_BOX },
  ],
  darwin: [],
};

/** A window in which every action but reading is refused. */
export interface ReadOnlyWindow {
  /** The app, tested on ActionRequest.app (trimmed). */
  readonly app: RegExp;
  /** The window's title, tested on ActionRequest.window (trimmed). */
  readonly title: RegExp;
  /**
   * The roles (ActionRequest.windowId.role) of the other windows with that app and title: one known to have such a role
   * isn't this window and is judged as usual. A request that doesn't carry the window's role is refused (fail closed).
   */
  readonly otherRole?: RegExp;
}

/**
 * Windows Ember only reads. Windows: the Run dialog (explorer.exe's "Run", titled in Windows' display languages), whose OK
 * and Enter run whatever its box holds, the last command typed there included, so a click is as good as typing one.
 * A File Explorer folder named "Run" has the same title and program, but it is a frame (CabinetWClass) where the Run
 * dialog is a dialog (Win32's dialog class, #32770, which the accessibility host reads as one): a folder window known
 * to be a frame is judged as usual, and one whose role the request doesn't carry is refused too. None on Linux and macOS.
 */
export const READ_ONLY_WINDOW: Readonly<Record<OS, readonly ReadOnlyWindow[]>> = {
  linux: [],
  win32: [{
    app: /^explorer(\.exe)?$/i,
    title: /^(run|ausführen|exécuter|ejecutar|esegui|executar|uitvoeren|ファイル名を指定して実行|运行|執行|실행|выполнить|виконати|изпълнение|uruchamianie|spustit|spustiť|pokretanje|zaženi|çalıştır|kör|kør|kjør|suorita|käivitamine|futtatás|εκτέλεση|הפעלה|تشغيل|executare|rulare|palaišana|vykdyti|เรียกใช้)$/iu,
    otherRole: /^frame$/,
  }],
  darwin: [],
};

/** An app that runs a program or script it opens, with no dialog: what is refused there. */
export interface OpensPrograms {
  /** The app, tested on ActionRequest.app (trimmed). */
  readonly app: RegExp;
  /** The name of an item that is a program or script, tested on the item's normalised name (ActionRequest.element.name, trimmed). */
  readonly item: RegExp;
  /**
   * Commands that open or run whatever is selected, as whole labels (written with their accents, folded when matched; an
   * access key or "…" may follow): the request doesn't say what is selected, so they are refused whatever it is.
   */
  readonly commands: readonly string[];
  /** The roles that carry those commands (default: menus, menu items, buttons and links: Explorer's ribbon and command bar). */
  readonly commandRoles?: RegExp;
  /** Keys that open the focused item, as policy.ts keyFamily spells them (default: Enter, with Ctrl or Shift too: Explorer's). */
  readonly openKey?: RegExp;
  /** Keys that move the keyboard off the selection or add the focused item to it (default: Explorer's Ctrl+arrows, Ctrl+Space); null: none. */
  readonly splitsSelection?: RegExp | null;
  /**
   * The app hides file types by default, so an item's name may hide a program's: one whose name shows no type ("setup",
   * a shortcut) is refused, and one that shows a document's ("invoice.pdf", which may be invoice.pdf.exe) is asked about.
   */
  readonly hidesTypes?: boolean;
  /** Roles whose items are only ever places (File Explorer's navigation pane: folders and drives): opened as any other. */
  readonly places?: RegExp;
}

/**
 * What File Explorer (and the desktop, also explorer.exe) runs with no dialog when it opens it: programs, scripts and
 * their hosts' files, installers and patches, screen savers, Control Panel items, shortcuts and Java archives. (Linux's
 * file manager asks first: RUN_FILE_DIALOG.)
 */
const RUNS_WHEN_OPENED = /\.(exe|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|pif|cpl|lnk|url|appref-ms|jar)$/i;

/**
 * Apps where opening an item runs it when it is a program or script, with no dialog. Windows: File Explorer and the
 * desktop, on a double click, Enter, or their Open, Open with, Run as administrator, Run as different user and Run with
 * PowerShell commands, in Windows' display languages (and a script's Open with Command Prompt, which runs it in a console,
 * in English). An item is known by the extension its name shows: where Explorer hides known extensions (its default) or
 * never shows them (shortcuts: .lnk, .url, .pif, .appref-ms) the name says nothing, and the request carries no file type
 * (UI Automation's ItemType, "Application", "Shortcut", isn't passed to the policy yet), so an item whose name shows no
 * type is refused and one whose name shows a document's type is asked about (`hidesTypes`); the navigation pane's items
 * are places. macOS: Finder, which runs apps, Terminal scripts (.command, .tool, .terminal), Java archives and file
 * locations it opens, and hides types too (an app's .app always); Cmd+O and Cmd+Down open there (Return renames). None
 * on Linux: its file manager asks first (RUN_FILE_DIALOG).
 */
export const OPENS_PROGRAMS: Readonly<Record<OS, readonly OpensPrograms[]>> = {
  linux: [],
  win32: [{
    app: /^explorer(\.exe)?$/i,
    item: RUNS_WHEN_OPENED,
    commands: [
      "open", "open with", "run as administrator", "run as different user", "run as a different user", "run with powershell",
      "open with command prompt",
      "öffnen", "öffnen mit", "als administrator ausführen", "als anderer benutzer ausführen", "mit powershell ausführen",
      "ouvrir", "ouvrir avec", "exécuter en tant qu'administrateur", "exécuter en tant qu'autre utilisateur", "exécuter avec powershell",
      "abrir", "abrir con", "abrir com", "ejecutar como administrador", "ejecutar como otro usuario", "ejecutar con powershell",
      "executar como administrador", "executar como outro usuário", "executar com o powershell",
      "apri", "apri con", "esegui come amministratore", "esegui come altro utente", "esegui con powershell",
      "openen", "openen met", "als administrator uitvoeren", "als andere gebruiker uitvoeren", "uitvoeren met powershell",
      "開く", "プログラムから開く", "管理者として実行", "別のユーザーとして実行", "powershell で実行",
      "打开", "打开方式", "以管理员身份运行", "以其他用户身份运行", "使用 powershell 运行",
      "開啟", "開啟檔案", "以系統管理員身分執行", "以不同使用者身分執行", "用 powershell 執行",
      "열기", "연결 프로그램", "관리자 권한으로 실행", "다른 사용자로 실행", "powershell에서 실행",
      "открыть", "открыть с помощью", "запуск от имени администратора", "запуск от имени другого пользователя", "выполнить с помощью powershell",
      "відкрити", "відкрити за допомогою", "запуск від імені адміністратора", "запуск від імені іншого користувача", "виконати за допомогою powershell",
      "отваряне", "отваряне с", "изпълнение като администратор", "изпълнение като друг потребител", "изпълнение с powershell",
      "otwórz", "otwórz za pomocą", "uruchom jako administrator", "uruchom jako inny użytkownik", "uruchom za pomocą programu powershell",
      "otevřít", "otevřít v programu", "spustit jako správce", "spustit jako jiný uživatel", "spustit pomocí powershellu",
      "otvoriť", "otvoriť pomocou", "spustiť ako správca", "spustiť ako iný používateľ", "spustiť pomocou powershellu",
      "otvori", "otvori pomoću", "pokreni kao administrator", "pokreni kao drugi korisnik", "pokreni pomoću powershella",
      "odpri", "odpri z", "zaženi kot skrbnik", "zaženi kot drug uporabnik", "zaženi s programom powershell",
      "aç", "birlikte aç", "yönetici olarak çalıştır", "farklı bir kullanıcı olarak çalıştır", "powershell ile çalıştır",
      "öppna", "öppna med", "kör som administratör", "kör som annan användare", "kör med powershell",
      "åbn", "åbn med", "kør som administrator", "kør som en anden bruger", "kør med powershell",
      "åpne", "åpne med", "kjør som administrator", "kjør som en annen bruker", "kjør med powershell",
      "avaa", "avaa sovelluksessa", "suorita järjestelmänvalvojana", "suorita toisena käyttäjänä", "suorita powershellillä",
      "ava", "ava rakendusega", "käivita administraatorina", "käivita teise kasutajana", "käivita powershelliga",
      "megnyitás", "társítás", "megnyitás a következővel", "futtatás rendszergazdaként", "futtatás más felhasználóként", "futtatás a powershell segítségével",
      "άνοιγμα", "άνοιγμα με", "εκτέλεση ως διαχειριστής", "εκτέλεση ως διαφορετικός χρήστης", "εκτέλεση με το powershell",
      "פתח", "פתח באמצעות", "הפעל כמנהל מערכת", "הפעל כמשתמש אחר", "הפעל באמצעות powershell",
      "فتح", "فتح باستخدام", "تشغيل كمسؤول", "تشغيل كمستخدم مختلف", "تشغيل باستخدام powershell",
      "deschidere", "deschidere cu", "executare ca administrator", "rulare ca administrator", "executare ca alt utilizator", "rulare cu powershell",
      "atvērt", "atvērt ar", "palaist kā administratoram", "palaist kā citam lietotājam", "palaist ar powershell",
      "atidaryti", "atidaryti naudojant", "vykdyti kaip administratoriui", "paleisti kaip administratorių", "vykdyti kaip kitam vartotojui",
      "เปิด", "เปิดด้วย", "เรียกใช้ในฐานะผู้ดูแลระบบ", "เรียกใช้ในฐานะผู้ใช้อื่น", "เรียกใช้ด้วย powershell",
      "executar como outro utilizador",
    ],
    hidesTypes: true,
    places: /^tree item$/,
  }],
  darwin: [{
    app: /^(finder|com\.apple\.finder)$/i,
    item: /\.(app|command|tool|terminal|jar|fileloc)$/i,
    commands: ["open", "open with", "öffnen", "öffnen mit", "ouvrir", "ouvrir avec", "abrir", "abrir con", "abrir com", "apri", "apri con", "open met",
      "開く", "このアプリケーションで開く", "打开", "打开方式", "打開", "打開檔案的應用程式", "열기", "다음으로 열기"],
    // Its menus' Open and Open With (a dialog's Open button belongs to the dialog: Gatekeeper's runs-program rule, an Open panel's).
    commandRoles: /^(menu|menu item)$/,
    openKey: /^(alt\+)?(shift\+)?cmd\+(o|down)$/,
    splitsSelection: null,
    hidesTypes: true,
  }],
};

/**
 * Does the user's request name a file (a path or a name with an extension), for the worker's note on a Save dialog's
 * suggestion (worker.ts dialogNote)? Windows also knows drive and network paths ("C:\…", "\\server\…").
 */
export const FILE_PATH_WORDS: Readonly<Record<OS, RegExp>> = (() => {
  const linux = /[~/][\w.-]|\.\w{1,5}\b/;
  return { linux, win32: /[~/][\w.-]|\.\w{1,5}\b|[A-Za-z]:\\|\\\\[\w.-]/, darwin: linux };
})();

/** How the user names the terminal as the way to do a task, for the host's refusal (host.ts startTask). */
export interface TerminalRequestWords {
  /**
   * They named the terminal (or a shell) as the way to do it: as what they open or use ("open the terminal", "use the
   * command line"), or where it's done ("run it in a terminal"). Not a word about it ("the terminal font").
   */
  readonly asks: RegExp;
  /** Or said not to use it ("in Files, not in the terminal", "without opening a terminal"): global, for String.replace. */
  readonly refuses: RegExp;
  /** A goal that names it itself. */
  readonly names: RegExp;
}

/** A terminal named as a thing to work in: not GNOME Shell's extensions, nor an app that only has "console" in its name. */
const TERMINAL = String.raw`(?:(?:gnome|kde|xfce)[- ])?(?:terminal|console(?![- ]companion))|command[- ]line|command prompt|shell(?![- ]extensions?\b)`
  // Or one word saying which terminal or shell ("the Linux terminal", "a bash shell", "a new terminal"; not GNOME's Shell).
  + String.raw`|(?!gnome\s)[\w.-]+\s+(?:terminal|shell(?![- ]extensions?\b))`;
/** Windows: also PowerShell, cmd and WSL by name ("open PowerShell", "in cmd"). */
const TERMINAL_WIN32 = String.raw`terminal|console(?![- ]companion)|command[- ]line|command prompt|power[- ]?shell|pwsh|cmd(?:\.exe)?|wsl|git[- ]bash|shell`
  + String.raw`|[\w.-]+\s+(?:terminal|shell)`;
/** macOS: also iTerm by name; never "console", which on a Mac is the log viewer. */
const TERMINAL_DARWIN = String.raw`terminal|iterm2?|command[- ]line|shell|[\w.-]+\s+(?:terminal|shell)`;

/** One OS's expressions for its words for a terminal (`terminal`: regular-expression source). */
function terminalWords(terminal: string, names: RegExp): TerminalRequestWords {
  return {
    asks: new RegExp(String.raw`\b(?:open|use|launch|start|run|type(?:\s+(?:in|into))?|work\s+in)\s+(?:up\s+)?(?:(?:a|an|the|my|your)\s+)?(?:new\s+)?(?:${terminal})\b|\b(?:in|into|from|via|using|with|through|on)\s+(?:(?:a|an|the|my|your)\s+)?(?:${terminal})\b`, "i"),
    refuses: new RegExp(String.raw`\b(?:not|never|without|instead\s+of|rather\s+than|don['’]?t)\s+(?:(?:use|using|open|opening)\s+)?(?:(?:in|into|from|via|using|with|through|on)\s+)?(?:(?:a|an|the|my|your)\s+)?(?:${terminal})\b`, "gi"),
    names,
  };
}

/** The user's words for the terminal, per OS. */
export const TERMINAL_REQUEST: Readonly<Record<OS, TerminalRequestWords>> = {
  linux: terminalWords(TERMINAL, /\b(?:terminal|shell|command[- ]line|command prompt|console)\b/i),
  win32: terminalWords(TERMINAL_WIN32, /\b(?:terminal|shell|command[- ]line|command prompt|console|power[- ]?shell|pwsh|cmd(?:\.exe)?|wsl)\b/i),
  darwin: terminalWords(TERMINAL_DARWIN, /\b(?:terminal|shell|command[- ]line|iterm2?)\b/i),
};

/**
 * Windows with WSL turned on (§3.15, critique integration-25): "WSL" alone names a place to work ("open gedit in
 * WSL"), not a terminal; "the WSL terminal" and "a WSL shell" still name one (the "<word> terminal|shell" form).
 */
export const TERMINAL_REQUEST_WSL: TerminalRequestWords = terminalWords(
  String.raw`terminal|console(?![- ]companion)|command[- ]line|command prompt|power[- ]?shell|pwsh|cmd(?:\.exe)?|git[- ]bash|shell|[\w.-]+\s+(?:terminal|shell)`,
  /\b(?:terminal|shell|command[- ]line|command prompt|console|power[- ]?shell|pwsh|cmd(?:\.exe)?)\b/i,
);

/** The terminal words in force: today's row for the OS, or the WSL row on Windows while WSL is on (chosen by state). */
export function terminalRequest(os: OS, wslOn: boolean): TerminalRequestWords {
  return os === "win32" && wslOn ? TERMINAL_REQUEST_WSL : TERMINAL_REQUEST[os];
}
