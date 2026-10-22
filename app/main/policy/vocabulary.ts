/**
 * The words the policy, the worker and the host match against, per OS: which windows are security prompts, which
 * apps are browsers, mail and office suites, which extra labels are risky, which boxes run what is typed into them,
 * how the user names the terminal, and what names a file. Pure data, keyed by OS, read through policy.ts and the
 * agent (one copy for every reader). The Linux rows are the expressions those files held before the port, moved
 * verbatim, and must not change (tests pin them).
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

/** File Explorer's address box ("Address", or "Address: <folder>" while it shows the path), in Windows' main languages. */
const ADDRESS_BOX = /^(address|adresse|dirección|indirizzo|endereço|adres|アドレス|地址|주소)(\s*[:：].*)?$/iu;
/** The Run dialog's "Open:" box, in Windows' main languages (an access key may follow: "打开(O):"). */
const RUN_BOX = /^(open|öffnen|ouvrir|abrir|apri|openen|打开|開啟|열기)\s*(\(\w\))?\s*[:：]?$/iu;

/**
 * Boxes where type_text and fill_cells refuse to type a program's name. Empty on Linux: GNOME has no such box.
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
 * Windows Ember only reads. Windows: the Run dialog (explorer.exe's "Run", titled in Windows' main languages), whose OK
 * and Enter run whatever its box holds, the last command typed there included, so a click is as good as typing one.
 * A File Explorer folder named "Run" has the same title and program, but it is a frame (CabinetWClass) where the Run
 * dialog is a dialog (Win32's dialog class, #32770, which the accessibility host reads as one): a folder window known
 * to be a frame is judged as usual, and one whose role the request doesn't carry is refused too. None on Linux and macOS.
 */
export const READ_ONLY_WINDOW: Readonly<Record<OS, readonly ReadOnlyWindow[]>> = {
  linux: [],
  win32: [{ app: /^explorer(\.exe)?$/i, title: /^(run|ausführen|exécuter|ejecutar|esegui|executar|uitvoeren|ファイル名を指定して実行|运行|執行|실행)$/iu, otherRole: /^frame$/ }],
  darwin: [],
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
